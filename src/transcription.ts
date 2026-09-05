import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { runProcess, type RunProcess } from "./process.js";
export const segmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
});
export type Segment = z.infer<typeof segmentSchema>;
export function validateSegments(input: unknown): Segment[] {
  const segments = z.array(segmentSchema).min(1).parse(input);
  let previous = -1;
  for (const segment of segments) {
    if (segment.endMs <= segment.startMs || segment.startMs < previous)
      throw new Error("Invalid or unordered transcript timestamps.");
    previous = segment.startMs;
  }
  return segments;
}
export function parseWhisper(raw: string): Segment[] {
  const data = z
    .object({
      transcription: z
        .array(
          z.object({ offsets: z.object({ from: z.number(), to: z.number() }), text: z.string() }),
        )
        .min(1),
    })
    .parse(JSON.parse(raw));
  return validateSegments(
    data.transcription.map((s) => ({ startMs: s.offsets.from, endMs: s.offsets.to, text: s.text })),
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
  try {
    return parseWhisper(await read(`${options.prefix}.json`));
  } catch {
    throw new Error("whisper.cpp produced missing, empty, or malformed segment JSON.");
  }
}
