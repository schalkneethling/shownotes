import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { extractAudio } from "../src/audio.js";
import { transcribe, parseWhisper } from "../src/transcription.js";
import { distill } from "../src/distillation.js";
import { runProcess } from "../src/process.js";

const segments = Array.from({ length: 8 }, (_, id) => ({
  startMs: id * 60000,
  endMs: (id + 1) * 60000,
  text: `Topic ${id}`,
}));
const brief = {
  titles: [
    "Building accessible components",
    "Keyboard testing live",
    "Accessible UI in TypeScript",
    "Testing a web component",
    "From component to keyboard support",
  ],
  descriptions: [
    ["We build a component.", "We test keyboard interaction."],
    ["Follow this component build.", "See the tests in action."],
  ],
  chapters: Array.from({ length: 5 }, (_, segmentId) => ({
    segmentId,
    title: `Topic ${segmentId}`,
  })),
  tags: ["web", "typescript", "accessibility", "testing", "components"],
};
function clientFor(text: string, stop_reason = "end_turn") {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text }],
          stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  return { client: new Anthropic({ apiKey: "test-only", fetch, maxRetries: 0 }), fetch };
}
describe("audio extraction", () => {
  it("passes paths as arguments and requests mono 16 kHz PCM", async () => {
    const run = vi.fn(async () => {});
    await extractAudio("/tmp/a $video.mp4", "/tmp/audio.wav", run);
    expect(run).toHaveBeenCalledWith("ffmpeg", [
      "-nostdin",
      "-y",
      "-i",
      "/tmp/a $video.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "/tmp/audio.wav",
    ]);
  });
  it("propagates extraction failure", async () => {
    await expect(
      extractAudio("video", "wav", async () => {
        throw new Error("ffmpeg failed");
      }),
    ).rejects.toThrow("ffmpeg failed");
  });
});
describe("transcription", () => {
  it("parses the actual whisper JSON shape using millisecond offsets", () => {
    expect(
      parseWhisper(
        JSON.stringify({
          transcription: [
            {
              timestamps: { from: "00:00:01,000", to: "00:00:02,000" },
              offsets: { from: 1000, to: 2000 },
              text: " Hello",
            },
          ],
        }),
      ),
    ).toEqual([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
  });
  it.each([
    "no json",
    "{}",
    '{"transcription":[]}',
    '{"transcription":[{"offsets":{"from":20,"to":10},"text":"x"}]}',
  ])("rejects invalid output %s", (raw) => {
    expect(() => parseWhisper(raw)).toThrow();
  });
  it("requests text and segment JSON at the specified prefix", async () => {
    const run = vi.fn(async () => {});
    const read = vi.fn(async () =>
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: "Hello" }] }),
    );
    expect(
      await transcribe(
        { audio: "/a.wav", model: "/model.bin", prefix: "/out/stream", binary: "whisper-cli" },
        run,
        read,
      ),
    ).toEqual([{ startMs: 0, endMs: 1000, text: "Hello" }]);
    expect(run).toHaveBeenCalledWith("whisper-cli", [
      "--model",
      "/model.bin",
      "--file",
      "/a.wav",
      "--output-txt",
      "--output-json",
      "--output-file",
      "/out/stream",
    ]);
    expect(read).toHaveBeenCalledWith("/out/stream.json");
  });
  it("propagates process failure without reading stale output", async () => {
    const read = vi.fn();
    await expect(
      transcribe(
        { audio: "a", model: "m", prefix: "o", binary: "whisper-cli" },
        async () => {
          throw new Error("transcription failed");
        },
        read,
      ),
    ).rejects.toThrow("transcription failed");
    expect(read).not.toHaveBeenCalled();
  });
});
describe("distillation through the real SDK with mocked transport", () => {
  it("sends structured output grammar and derives times from segment IDs", async () => {
    const { client, fetch } = clientFor(JSON.stringify(brief));
    const result = await distill(segments, client, "claude-haiku-4-5-20251001");
    expect(result.chapters[1]).toEqual({ startMs: 60000, title: "Topic 1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(request[1].body));
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[0].content).toContain("Topic 7");
    expect(body.messages[0].content).toContain("segmentId");
  });
  it.each([
    "not JSON",
    "{}",
    JSON.stringify({ ...brief, titles: [""] }),
    JSON.stringify({ ...brief, tags: ["one"] }),
    JSON.stringify({ ...brief, descriptions: [["one"]] }),
    JSON.stringify({
      ...brief,
      chapters: [{ segmentId: 99, title: "Bad" }, ...brief.chapters.slice(1)],
    }),
  ])("rejects malformed or incomplete brief", async (text) => {
    const { client } = clientFor(text);
    await expect(distill(segments, client, "test")).rejects.toThrow();
  });
  it.each(["max_tokens", "refusal"])("rejects %s", async (reason) => {
    await expect(
      distill(segments, clientFor(JSON.stringify(brief), reason).client, "test"),
    ).rejects.toThrow();
  });
  it("rejects duplicate/out-of-order chapters", async () => {
    await expect(
      distill(
        segments,
        clientFor(
          JSON.stringify({
            ...brief,
            chapters: [brief.chapters[0], brief.chapters[0], ...brief.chapters.slice(2)],
          }),
        ).client,
        "test",
      ),
    ).rejects.toThrow();
  });
});
describe("process errors", () => {
  it("names missing dependencies", async () => {
    await expect(runProcess("shownotes-nonexistent-binary", [])).rejects.toThrow(
      "Missing dependency: shownotes-nonexistent-binary",
    );
  });
  it("reports nonzero exits", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.exit(7)"])).rejects.toThrow("exit 7");
  });
});
it("cancels a running subprocess", async () => {
  const controller = new AbortController();
  const result = runProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{},10000)"],
    controller.signal,
  );
  controller.abort();
  await expect(result).rejects.toThrow();
});

describe("transcription output diagnostics", () => {
  it.each([
    { code: "ENOENT", expected: "Missing Whisper JSON output file" },
    { code: "EACCES", expected: "Unreadable Whisper JSON output file" },
  ])("distinguishes $code without echoing the read error", async ({ code, expected }) => {
    await expect(
      transcribe(
        { audio: "audio", model: "model", prefix: "output", binary: "whisper-cli" },
        async () => {},
        async () => {
          throw Object.assign(new Error("PRIVATE_TRANSCRIPT_TEST"), { code });
        },
      ),
    ).rejects.toThrow(expected);
  });
  it.each([
    { raw: '{"PRIVATE_TRANSCRIPT_TEST":', expected: "Malformed Whisper JSON: invalid JSON syntax" },
    {
      raw: "{}",
      expected: "Invalid Whisper segment schema: transcription must be a nonempty array",
    },
    {
      raw: '{"transcription":[]}',
      expected: "Invalid Whisper segment schema: transcription must be a nonempty array",
    },
    {
      raw: JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: "PRIVATE_TRANSCRIPT_TEST" }, text: "PRIVATE_TRANSCRIPT_TEST" },
        ],
      }),
      expected: "Invalid Whisper segment schema at index 0: offsets.to must be a number",
    },
    {
      raw: JSON.stringify({
        transcription: [{ offsets: { from: -1, to: 10 }, text: "PRIVATE_TRANSCRIPT_TEST" }],
      }),
      expected: "Invalid segment schema at index 0: startMs must be a nonnegative integer",
    },
    {
      raw: JSON.stringify({ transcription: [{ offsets: { from: 0, to: 10 }, text: " " }] }),
      expected: "Invalid segment schema at index 0: text must be a nonempty string",
    },
    {
      raw: JSON.stringify({
        transcription: [{ offsets: { from: 20, to: 20 }, text: "PRIVATE_TRANSCRIPT_TEST" }],
      }),
      expected: "Invalid segment timestamps at index 0: endMs must be greater than startMs",
    },
    {
      raw: JSON.stringify({
        transcription: [
          { offsets: { from: 20, to: 30 }, text: "PRIVATE_TRANSCRIPT_TEST" },
          { offsets: { from: 10, to: 40 }, text: "PRIVATE_TRANSCRIPT_TEST" },
        ],
      }),
      expected:
        "Invalid segment timestamps at index 1: startMs must not precede the previous segment startMs",
    },
  ])("reports a safe category/index/reason: $expected", async ({ raw, expected }) => {
    let error: unknown;
    try {
      await transcribe(
        { audio: "a", model: "m", prefix: "o", binary: "whisper-cli" },
        async () => {},
        async () => raw,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("PRIVATE_TRANSCRIPT_TEST");
  });
});

it("rejects truncated JSON at the output budget without retrying", async () => {
  const { client, fetch } = clientFor('{"titles":', "max_tokens");
  await expect(distill(segments, client, "test")).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("bounds paragraphs so a description plus chapters fits YouTube", async () => {
  const { client } = clientFor(
    JSON.stringify({
      ...brief,
      descriptions: [["x".repeat(1201), "second"], brief.descriptions[1]],
    }),
  );
  await expect(distill(segments, client, "test")).rejects.toThrow();
});
