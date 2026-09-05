import { resolve } from "node:path";
import { createLocalServer } from "./server.js";
import { pipeline, productionDependencies } from "./pipeline.js";
const controller = new AbortController();
const port = Number(process.env.PORT || 4317);
const maxBytes = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 ** 2;
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isSafeInteger(maxBytes) ||
  maxBytes < 1
)
  throw new Error("PORT must be 1–65535 and MAX_UPLOAD_MB must be a positive safe size.");
const server = createLocalServer({
  out: resolve(process.env.SHOWNOTES_OUT || "output"),
  maxBytes,
  processVideo: (input, out, reuse, onProgress, chapters) =>
    pipeline(
      {
        input,
        out,
        binary: process.env.WHISPER_BINARY || "whisper-cli",
        model: process.env.WHISPER_MODEL,
        forceTranscribe: !reuse,
        onProgress,
        chapters,
      },
      productionDependencies(
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_MODEL,
        controller.signal,
      ),
    ),
});
server.on("error", (error) => {
  console.error(`Cannot start local server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Shownotes: http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    controller.abort();
    server.close();
    server.closeAllConnections();
  });
