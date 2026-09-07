import type { Segment } from "./transcription.js";
export interface ChapterSettings {
  enabled: boolean;
  count?: number;
  minDurationSeconds: number;
}
export function normalizeChapterSettings(input: Partial<ChapterSettings> = {}): ChapterSettings {
  const enabled = input.enabled ?? true;
  const minDurationSeconds = input.minDurationSeconds ?? 10;
  if (typeof enabled !== "boolean") throw new Error("Include chapters must be true or false.");
  if (
    input.count !== undefined &&
    (!Number.isInteger(input.count) || input.count < 1 || input.count > 8)
  )
    throw new Error("Chapter count must be an integer from 1 to 8, or auto.");
  if (!Number.isInteger(minDurationSeconds) || minDurationSeconds < 1 || minDurationSeconds > 3600)
    throw new Error("Minimum chapter duration must be an integer from 1 to 3600 seconds.");
  if (!enabled) return { enabled: false, minDurationSeconds: 10 };
  return {
    enabled: true,
    ...(input.count === undefined ? {} : { count: input.count }),
    minDurationSeconds,
  };
}
export function parseChapterSettings(input: {
  enabled?: string;
  count?: string;
  minDurationSeconds?: string;
}): ChapterSettings {
  if (input.enabled !== undefined && input.enabled !== "true" && input.enabled !== "false")
    throw new Error("Include chapters must be true or false.");
  return normalizeChapterSettings({
    enabled: input.enabled !== "false",
    count: input.count === undefined || input.count === "auto" ? undefined : Number(input.count),
    minDurationSeconds:
      input.minDurationSeconds === undefined ? undefined : Number(input.minDurationSeconds),
  });
}
export function planChapters(segments: Segment[], input: Partial<ChapterSettings> = {}) {
  const settings = normalizeChapterSettings(input);
  const minDurationMs = settings.minDurationSeconds * 1000;
  if (!settings.enabled) return { settings, minCount: 0, maxCount: 0, minDurationMs };
  const endMs = segments[segments.length - 1]?.endMs ?? 0;
  let capacity = segments.length && endMs >= minDurationMs ? 1 : 0;
  let previous = 0;
  if (capacity)
    for (const segment of segments.slice(1)) {
      const startMs = Math.floor(segment.startMs / 1000) * 1000;
      if (startMs - previous >= minDurationMs && endMs - startMs >= minDurationMs) {
        capacity++;
        previous = startMs;
      }
    }
  const minCount = settings.count ?? 5;
  if (capacity < minCount)
    throw new Error(
      `Cannot create ${minCount} chapters with a ${settings.minDurationSeconds}-second minimum at the supplied segment boundaries (at most ${capacity} fit). Disable chapters or lower the count/minimum duration. No request was sent to Claude.`,
    );
  return { settings, minCount, maxCount: settings.count ?? Math.min(8, capacity), minDurationMs };
}
