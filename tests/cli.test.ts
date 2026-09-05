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
