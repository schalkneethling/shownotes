import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { extractAudio } from "./audio.js";
import { defaultClaudeModel, distill, type Brief } from "./distillation.js";
import { runProcess } from "./process.js";
import {
  transcribe,
  validateSegments,
  TranscriptionOutputError,
  type Segment,
} from "./transcription.js";
import { normalizeChapterSettings, planChapters, type ChapterSettings } from "./chapters.js";
import { renderBrief } from "./render.js";
import { createDiagnosticRun, finishDiagnosticRun, type DiagnosticRun } from "./diagnostics.js";
export interface PipelineOptions {
  input: string;
  out?: string;
  model?: string;
  binary: string;
  skipTranscribe?: boolean;
  forceTranscribe?: boolean;
  onProgress?: (stage: string) => void;
  chapters?: Partial<ChapterSettings>;
}
export interface Dependencies {
  check: typeof runProcess;
  extract: typeof extractAudio;
  transcribe: typeof transcribe;
  distill: (segments: Segment[], chapters: ChapterSettings) => Promise<Brief>;
}
export function productionDependencies(
  apiKey: string | undefined,
  claudeModel = defaultClaudeModel,
  signal?: AbortSignal,
): Dependencies {
  if (!apiKey?.trim())
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Start through Varlock after configuring the 1Password reference.",
    );
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const run = (binary: string, args: string[]) => {
    signal?.throwIfAborted();
    return runProcess(binary, args, signal);
  };
  return {
    check: run,
    extract: (input, output) => extractAudio(input, output, run),
    transcribe: (options) => transcribe(options, run),
    distill: (segments, chapters) => distill(segments, client, claudeModel, signal, chapters),
  };
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function validateMp4(path: string): Promise<void> {
  if (extname(path).toLowerCase() !== ".mp4") throw new Error("Select an MP4 file.");
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("Invalid MP4 header: expected an ISO media file.");
  } finally {
    await file.close();
  }
}
async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function pipeline(
  options: PipelineOptions,
  deps: Dependencies,
): Promise<{ brief: Brief; prefix: string; reused: boolean }> {
  const chapters = normalizeChapterSettings(options.chapters);
  const input = resolve(options.input);
  const out = resolve(options.out ?? dirname(input));
  const progress = options.onProgress ?? (() => {});
  progress("Checking recording");
  await validateMp4(input);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const prefix = join(out, basename(input, extname(input)));
  progress("Checking transcript cache");
  const inputHash = await hashFile(input);
  let modelIdentity: string | undefined;
  if (options.model) {
    const info = await stat(options.model).catch(() => {
      throw new Error(`Whisper model not found: ${options.model}`);
    });
    modelIdentity = `${resolve(options.model)}:${info.size}:${info.mtimeMs}`;
  }
  let segments: Segment[] | undefined;
  if (!options.forceTranscribe) {
    try {
      const cache = JSON.parse(await readFile(`${prefix}.transcript.json`, "utf8"));
      if (
        cache.version === 1 &&
        cache.inputHash === inputHash &&
        cache.binary === options.binary &&
        (!modelIdentity || cache.modelIdentity === modelIdentity)
      )
        segments = validateSegments(cache.segments);
    } catch {
      /* A missing or invalid cache is a miss; strict reuse is handled below. */
    }
  }
  const reused = Boolean(segments);
  if (!segments && options.skipTranscribe)
    throw new Error(
      "No valid transcript cache for this recording/model. Run again without --skip-transcribe.",
    );
  if (!segments) {
    if (!options.model)
      throw new Error("Missing Whisper model. Supply --model or configure WHISPER_MODEL.");
    await deps.check("ffmpeg", ["-version"]);
    await deps.check(options.binary, ["--help"]);
    const scratch = await mkdtemp(join(out, ".shownotes-"));
    let diagnostics: DiagnosticRun | undefined;
    let preserveDiagnostics = false;
    let failed = false;
    let operationError: unknown;
    try {
      const audio = join(scratch, "audio.wav");
      progress("Extracting audio");
      await deps.extract(input, audio);
      progress("Transcribing locally");
      diagnostics = await createDiagnosticRun(out);
      try {
        segments = await deps.transcribe({
          audio,
          model: resolve(options.model),
          prefix: join(diagnostics.path, "whisper"),
          binary: options.binary,
        });
        segments = validateSegments(segments);
      } catch (error) {
        if (error instanceof TranscriptionOutputError) {
          preserveDiagnostics = true;
          throw new Error(
            `${error.message}\nWhisper diagnostic directory: ${diagnostics.path} (raw JSON/TXT retained if emitted).`,
            { cause: error },
          );
        }
        throw error;
      }
      await atomicWrite(
        `${prefix}.transcript.json`,
        JSON.stringify(
          { version: 1, inputHash, binary: options.binary, modelIdentity, segments },
          null,
          2,
        ) + "\n",
      );
    } catch (error) {
      failed = true;
      operationError = error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (diagnostics) {
      try {
        await finishDiagnosticRun(diagnostics, preserveDiagnostics);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const original = failed
        ? `${operationError instanceof Error ? operationError.message : "Processing failed."}\n`
        : "";
      throw new AggregateError(
        [...(failed ? [operationError] : []), ...cleanupErrors],
        `${original}Cleanup failed: ${cleanupErrors.map((error) => (error instanceof Error ? error.message : "Unknown cleanup error")).join("; ")}`,
      );
    }
    if (failed) throw operationError;
  }
  if (!segments) throw new Error("No validated transcript was produced.");
  await atomicWrite(`${prefix}.transcript.txt`, segments.map((s) => s.text).join("\n") + "\n");
  planChapters(segments, chapters);
  progress(reused ? "Reusing transcript · generating candidates" : "Generating candidates");
  const brief = await deps.distill(segments, chapters);
  await atomicWrite(`${prefix}.brief.md`, renderBrief(brief));
  progress("Complete");
  return { brief, prefix, reused };
}
