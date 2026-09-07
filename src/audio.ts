import { runProcess, type RunProcess } from "./process.js";
export async function extractAudio(
  input: string,
  output: string,
  run: RunProcess = runProcess,
): Promise<void> {
  await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}
