import { parseArgs } from "node:util";
import { parseChapterSettings } from "./chapters.js";
export function parseOptions(args: string[], env: NodeJS.ProcessEnv) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      model: { type: "string" },
      out: { type: "string" },
      "skip-transcribe": { type: "boolean" },
      "force-transcribe": { type: "boolean" },
      "no-chapters": { type: "boolean" },
      "chapter-count": { type: "string" },
      "chapter-min-seconds": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (!values.help && positionals.length !== 1)
    throw new Error("Provide exactly one MP4 path. Run video-brief --help for usage.");
  if (values["skip-transcribe"] && values["force-transcribe"])
    throw new Error("Choose either --skip-transcribe or --force-transcribe.");
  return {
    chapters: parseChapterSettings({
      enabled: values["no-chapters"] ? "false" : "true",
      count: values["chapter-count"],
      minDurationSeconds: values["chapter-min-seconds"],
    }),
    help: values.help ?? false,
    input: positionals[0] ?? "",
    out: values.out,
    model: values.model ?? env.WHISPER_MODEL,
    binary: env.WHISPER_BINARY || "whisper-cli",
    skipTranscribe: values["skip-transcribe"],
    forceTranscribe: values["force-transcribe"],
  };
}
export const help = `Usage: video-brief recording.mp4 [options]

--out DIRECTORY       Write the output bundle here (default: beside input)
--model FILE          Local ggml model (default: WHISPER_MODEL)
--skip-transcribe     Require and reuse a valid cached transcript
--force-transcribe    Regenerate the transcript even when cache matches
--no-chapters         Generate titles/descriptions/tags without chapters
--chapter-count N     Exact count 1–8, or auto (default: automatic 5–8)
--chapter-min-seconds N  Minimum duration 1–3600 seconds (default: 10)
--help, -h            Show this help

Matching transcripts are reused by default. CLI copy defaults to candidate 1;
all five titles and both descriptions are included in the brief.
Run with internal Varlock configuration: npm run brief -- recording.mp4 --out output
Diagnostic maintenance (no secrets): video-brief diagnostics --help
`;
