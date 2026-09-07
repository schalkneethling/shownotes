import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
import { extractAudio } from "../src/audio.js";
import { transcribe } from "../src/transcription.js";
it.skipIf(process.env.SHOWNOTES_INTEGRATION !== "1")(
  "extracts and transcribes generated speech using real local binaries",
  async () => {
    if (process.platform !== "darwin") throw new Error("This opt-in fixture uses macOS say.");
    const model = process.env.WHISPER_MODEL;
    if (!model) throw new Error("Set WHISPER_MODEL for the integration test.");
    const dir = await mkdtemp(join(tmpdir(), "shownotes-integration-"));
    const run = (binary: string, args: string[]) =>
      runProcess(binary, args, AbortSignal.timeout(300000));
    try {
      console.log("Integration: generating synthetic speech");
      await run("/usr/bin/say", [
        "-o",
        join(dir, "speech.aiff"),
        "Welcome to this developer recording. Today we are building an accessible website. We will test keyboard navigation and improve the user experience.",
      ]);
      console.log("Integration: encoding MP4");
      await run("ffmpeg", [
        "-nostdin",
        "-y",
        "-i",
        join(dir, "speech.aiff"),
        "-c:a",
        "aac",
        join(dir, "speech.mp4"),
      ]);
      await extractAudio(join(dir, "speech.mp4"), join(dir, "speech.wav"), run);
      console.log("Integration: transcribing with installed Whisper model");
      const wav = await readFile(join(dir, "speech.wav"));
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      const segments = await transcribe(
        {
          audio: join(dir, "speech.wav"),
          model,
          prefix: join(dir, "speech"),
          binary: process.env.WHISPER_BINARY || "whisper-cli",
        },
        run,
      );
      expect(
        segments
          .map((s) => s.text)
          .join(" ")
          .toLowerCase(),
      ).toContain("website");
      expect(segments[0]!.endMs).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  600000,
);
