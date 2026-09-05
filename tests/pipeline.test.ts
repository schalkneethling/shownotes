import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "../src/pipeline.js";
import { transcribe } from "../src/transcription.js";
import { formatTimestamp, renderBrief } from "../src/render.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const brief = {
  titles: ["One", "Two", "Three", "Four", "Five"],
  descriptions: [
    ["First paragraph.", "Second paragraph."],
    ["Alternate opening.", "Alternate ending."],
  ],
  chapters: [{ startMs: 0, title: "Intro" }],
  tags: ["web"],
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "shownotes-test-"));
  dirs.push(dir);
  const input = join(dir, "stream.mp4");
  await writeFile(
    input,
    Buffer.from([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112,
      52, 50,
    ]),
  );
  const model = join(dir, "model.bin");
  await writeFile(model, "synthetic");
  const deps = {
    check: vi.fn(async () => {}),
    extract: vi.fn(async () => {}),
    transcribe: vi.fn(async () => [{ startMs: 0, endMs: 60000, text: "Synthetic transcript" }]),
    distill: vi.fn(async () => brief),
  };
  return { dir, input, model, deps };
}
describe("pipeline", () => {
  it("reuses matching cache, preserves outputs and removes temp audio directories", async () => {
    const { dir, input, model, deps } = await setup();
    await pipeline({ input, out: dir, model, binary: "whisper-cli" }, deps);
    await pipeline({ input, out: dir, model, binary: "whisper-cli", skipTranscribe: true }, deps);
    expect(await readdir(join(dir, ".whisper-diagnostics"))).toEqual([".owner"]);
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.distill).toHaveBeenCalledTimes(2);
    expect(await readFile(join(dir, "stream.transcript.txt"), "utf8")).toContain(
      "Synthetic transcript",
    );
    expect((await readdir(dir)).some((name) => name.startsWith(".shownotes-"))).toBe(false);
  });
  it("invalidates changed content with the same filename", async () => {
    const s = await setup();
    const opts = { input: s.input, out: s.dir, model: s.model, binary: "whisper-cli" };
    await pipeline(opts, s.deps);
    await writeFile(s.input, Buffer.concat([await readFile(s.input), Buffer.from("changed")]));
    await expect(pipeline({ ...opts, skipTranscribe: true }, s.deps)).rejects.toThrow("cache");
    await pipeline(opts, s.deps);
    expect(s.deps.extract).toHaveBeenCalledTimes(2);
  });
  it("invalidates changed model configuration", async () => {
    const s = await setup();
    const opts = { input: s.input, out: s.dir, model: s.model, binary: "whisper-cli" };
    await pipeline(opts, s.deps);
    await writeFile(s.model, "changed-model");
    await expect(pipeline({ ...opts, skipTranscribe: true }, s.deps)).rejects.toThrow("cache");
  });
  it("fails explicitly for missing strict reuse cache", async () => {
    const s = await setup();
    await expect(
      pipeline({ input: s.input, out: s.dir, binary: "whisper-cli", skipTranscribe: true }, s.deps),
    ).rejects.toThrow("cache");
    expect(s.deps.extract).not.toHaveBeenCalled();
  });
  it("cleans scratch after failure, retaining the transcript for distillation retry", async () => {
    const s = await setup();
    s.deps.distill.mockRejectedValueOnce(new Error("API unavailable"));
    await expect(
      pipeline({ input: s.input, out: s.dir, model: s.model, binary: "whisper-cli" }, s.deps),
    ).rejects.toThrow("API unavailable");
    expect(await readFile(join(s.dir, "stream.transcript.txt"), "utf8")).toContain("Synthetic");
    expect((await readdir(s.dir)).some((name) => name.startsWith(".shownotes-"))).toBe(false);
  });
  it("rejects mislabeled non-MP4 data before extraction", async () => {
    const s = await setup();
    await writeFile(s.input, "not a video");
    await expect(
      pipeline({ input: s.input, out: s.dir, model: s.model, binary: "whisper-cli" }, s.deps),
    ).rejects.toThrow("MP4");
  });
});
describe("rendering", () => {
  it("formats long videos and copyable defaults plus alternatives", () => {
    expect(formatTimestamp(3661000)).toBe("1:01:01");
    expect(formatTimestamp(0)).toBe("00:00");
    const output = renderBrief(brief);
    expect(output).toContain("00:00 Intro");
    expect(output).toContain("Alternate opening.");
    expect(output).toContain("Five");
  });
});

describe("failed Whisper output retention", () => {
  it.each([
    { raw: null, expected: "Missing Whisper JSON output file" },
    { raw: '{"PRIVATE_TRANSCRIPT_TEST":', expected: "Malformed Whisper JSON" },
    {
      raw: JSON.stringify({
        transcription: [{ offsets: { from: 50, to: 20 }, text: "PRIVATE_TRANSCRIPT_TEST" }],
      }),
      expected: "Invalid segment timestamps at index 0",
    },
  ])("keeps available raw output and removes audio: $expected", async ({ raw, expected }) => {
    const s = await setup();
    const deps = {
      ...s.deps,
      extract: async (_input: string, audio: string) => {
        await writeFile(audio, "synthetic audio");
      },
      transcribe: async (options: Parameters<typeof transcribe>[0]) =>
        transcribe(options, async () => {
          if (raw !== null) await writeFile(`${options.prefix}.json`, raw);
          await writeFile(`${options.prefix}.txt`, "PRIVATE_TRANSCRIPT_TEST");
        }),
    };
    const opts = { input: s.input, out: s.dir, model: s.model, binary: "whisper-cli" };
    for (let attempt = 0; attempt < 2; attempt++) {
      let failure: unknown;
      try {
        await pipeline(opts, deps);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(expected);
      expect(message).toContain(join(s.dir, ".whisper-diagnostics"));
      expect(message).not.toContain("PRIVATE_TRANSCRIPT_TEST");
    }
    const diagnosticRoot = join(s.dir, ".whisper-diagnostics");
    const runs = (await readdir(diagnosticRoot)).filter((name) => name !== ".owner");
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const dir = join(diagnosticRoot, run);
      expect(await readFile(join(dir, "whisper.txt"), "utf8")).toBe("PRIVATE_TRANSCRIPT_TEST");
      if (raw !== null) expect(await readFile(join(dir, "whisper.json"), "utf8")).toBe(raw);
      expect((await readdir(dir)).sort()).toEqual(
        raw === null ? ["run.json", "whisper.txt"] : ["run.json", "whisper.json", "whisper.txt"],
      );
    }
    const files = await readdir(s.dir);
    expect(files.some((file) => file.startsWith(".shownotes-"))).toBe(false);
    expect(files).not.toContain("stream.transcript.json");
    expect(s.deps.distill).not.toHaveBeenCalled();
  });
});
