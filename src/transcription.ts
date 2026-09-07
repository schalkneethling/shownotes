import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { runProcess, type RunProcess } from "./process.js";
export const segmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
});
export type Segment = z.infer<typeof segmentSchema>;
export class TranscriptionOutputError extends Error {
  constructor(
    readonly kind: "file" | "json" | "schema" | "timestamps",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionOutputError";
  }
}
export function validateSegments(input: unknown): Segment[] {
  const result = z.array(segmentSchema).min(1).safeParse(input);
  if (!result.success) {
    const path = result.error.issues[0]?.path ?? [];
    const index = typeof path[0] === "number" ? path[0] : undefined;
    const field = path[1];
    const reason =
      field === "startMs" || field === "endMs"
        ? `${field} must be a nonnegative integer`
        : field === "text"
          ? "text must be a nonempty string"
          : "expected an object with startMs, endMs, and text";
    throw new TranscriptionOutputError(
      "schema",
      index === undefined
        ? "Invalid segment schema: expected a nonempty segment array."
        : `Invalid segment schema at index ${index}: ${reason}.`,
    );
  }
  const segments = result.data;
  let previous = -1;
  for (const [index, segment] of segments.entries()) {
    if (segment.endMs <= segment.startMs)
      throw new TranscriptionOutputError(
        "timestamps",
        `Invalid segment timestamps at index ${index}: endMs must be greater than startMs.`,
      );
    if (segment.startMs < previous)
      throw new TranscriptionOutputError(
        "timestamps",
        `Invalid segment timestamps at index ${index}: startMs must not precede the previous segment startMs.`,
      );
    previous = segment.startMs;
  }
  return segments;
}
export function parseWhisper(raw: string): Segment[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TranscriptionOutputError("json", "Malformed Whisper JSON: invalid JSON syntax.");
  }
  const result = z
    .object({
      transcription: z
        .array(
          z.object({
            offsets: z.object({ from: z.number(), to: z.number() }),
            text: z.string(),
          }),
        )
        .min(1),
    })
    .safeParse(value);
  if (!result.success) {
    const path = result.error.issues[0]?.path ?? [];
    const index = typeof path[1] === "number" ? path[1] : undefined;
    const reason =
      path[2] === "text"
        ? "text must be a string"
        : path[2] === "offsets" && (path[3] === "from" || path[3] === "to")
          ? `offsets.${path[3]} must be a number`
          : path[2] === "offsets"
            ? "offsets must contain numeric from and to fields"
            : "expected an object with offsets and text";
    throw new TranscriptionOutputError(
      "schema",
      index === undefined
        ? "Invalid Whisper segment schema: transcription must be a nonempty array."
        : `Invalid Whisper segment schema at index ${index}: ${reason}.`,
    );
  }
  return validateSegments(
    result.data.transcription.map((s) => ({
      startMs: s.offsets.from,
      endMs: s.offsets.to,
      text: s.text,
    })),
  );
}
export async function transcribe(
  options: { audio: string; model: string; prefix: string; binary: string },
  run: RunProcess = runProcess,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Segment[]> {
  await run(options.binary, [
    "--model",
    options.model,
    "--file",
    options.audio,
    "--output-txt",
    "--output-json",
    "--output-file",
    options.prefix,
  ]);
  let raw: string;
  try {
    raw = await read(`${options.prefix}.json`);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new TranscriptionOutputError(
      "file",
      `${missing ? "Missing" : "Unreadable"} Whisper JSON output file: ${options.prefix}.json`,
    );
  }
  return parseWhisper(raw);
}
