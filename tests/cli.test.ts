import { expect, it } from "vitest";
import { parseOptions } from "../src/options.js";
it("parses the documented CLI and reads explicit config", () => {
  expect(
    parseOptions(["stream.mp4", "--out", "output", "--skip-transcribe"], {
      WHISPER_MODEL: "/model",
      WHISPER_BINARY: "/whisper",
    }),
  ).toMatchObject({
    input: "stream.mp4",
    out: "output",
    skipTranscribe: true,
    model: "/model",
    binary: "/whisper",
  });
});
it.each([
  { args: [] },
  { args: ["a.mp4", "b.mp4"] },
  { args: ["a.mp4", "--unknown"] },
  { args: ["a.mp4", "--skip-transcribe", "--force-transcribe"] },
])("rejects ambiguous arguments", ({ args }) => {
  expect(() => parseOptions(args, {})).toThrow();
});
it("supports help without prerequisites", () => {
  expect(parseOptions(["--help"], {}).help).toBe(true);
});
it("parses chapter controls with preserved defaults", () => {
  expect(parseOptions(["a.mp4"], {}).chapters).toEqual({ enabled: true, minDurationSeconds: 10 });
  expect(parseOptions(["a.mp4", "--no-chapters"], {}).chapters.enabled).toBe(false);
  expect(
    parseOptions(["a.mp4", "--chapter-count", "3", "--chapter-min-seconds", "5"], {}).chapters,
  ).toEqual({ enabled: true, count: 3, minDurationSeconds: 5 });
});
it.each(["0", "9", "abc"])("rejects invalid chapter counts %s", (count) => {
  expect(() => parseOptions(["a.mp4", "--chapter-count", count], {})).toThrow();
});
