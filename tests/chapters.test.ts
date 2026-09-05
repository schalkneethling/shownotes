import { expect, it } from "vitest";
import { normalizeChapterSettings, planChapters } from "../src/chapters.js";
const short = [0, 7000, 14000, 21000].map((startMs, i) => ({
  startMs,
  endMs: i === 3 ? 26200 : startMs + 7000,
  text: "Synthetic speech",
}));
it("keeps automatic 5–8 and 10 seconds as defaults", () => {
  expect(normalizeChapterSettings()).toEqual({ enabled: true, minDurationSeconds: 10 });
  const segments = Array.from({ length: 8 }, (_, i) => ({
    startMs: i * 60000,
    endMs: (i + 1) * 60000,
    text: "Speech",
  }));
  expect(planChapters(segments)).toMatchObject({ minCount: 5, maxCount: 8, minDurationMs: 10000 });
});
it("allows a short transcript when chapters are omitted", () => {
  expect(planChapters(short, { enabled: false })).toMatchObject({ minCount: 0, maxCount: 0 });
});
it("checks segment boundaries and final tail when applying custom settings", () => {
  expect(planChapters(short, { count: 3, minDurationSeconds: 5 })).toMatchObject({
    minCount: 3,
    maxCount: 3,
    minDurationMs: 5000,
  });
  expect(() => planChapters(short)).toThrow("at most 2");
  expect(() => planChapters(short, { count: 4, minDurationSeconds: 7 })).toThrow("at most 3");
  const sparse = [0, 1000, 2000, 50000].map((startMs, i) => ({
    startMs,
    endMs: i === 3 ? 60000 : startMs + 1000,
    text: "Speech",
  }));
  expect(() => planChapters(sparse)).toThrow("segment boundaries");
});
it("caps the automatic maximum at the feasible number", () => {
  const segments = Array.from({ length: 6 }, (_, i) => ({
    startMs: i * 10000,
    endMs: (i + 1) * 10000,
    text: "Speech",
  }));
  expect(planChapters(segments)).toMatchObject({ minCount: 5, maxCount: 6 });
});
it.each([
  { count: 0 },
  { count: 9 },
  { count: 2.5 },
  { minDurationSeconds: 0 },
  { minDurationSeconds: Infinity },
  { minDurationSeconds: 1.5 },
])("rejects invalid settings", (settings) => {
  expect(() => normalizeChapterSettings(settings)).toThrow();
});
