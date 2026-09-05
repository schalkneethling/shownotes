import { parseArgs } from "node:util";
import { listDiagnostics, deleteDiagnosticRun } from "./diagnostics.js";
export async function runDiagnosticsCommand(
  args: string[],
  write: (line: string) => void = console.log,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      out: { type: "string", default: "output" },
      delete: { type: "string" },
      scope: { type: "string", default: "." },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    write(
      "Usage: video-brief diagnostics [--out DIRECTORY] [--delete RUN_ID --scope VIDEO_HASH]\nLists file names and sizes only. Explicit --delete removes one retained diagnostic run; saved transcripts/briefs and active runs are protected. Default scope: . (direct output directory).",
    );
    return;
  }
  if (positionals.length) throw new Error("Unexpected diagnostic command arguments.");
  if (values.delete) {
    await deleteDiagnosticRun(values.out, values.scope, values.delete);
    write(`Deleted diagnostic run ${values.delete} in scope ${values.scope}.`);
    return;
  }
  if (values.scope !== ".") throw new Error("--scope is only used with --delete.");
  const runs = await listDiagnostics(values.out);
  if (!runs.length) {
    write("No diagnostic runs retained.");
    return;
  }
  for (const run of runs)
    write(
      `${run.id} | scope ${run.scope} | ${run.state} | ${run.bytes} bytes | ${run.createdAt}\n${run.files.map((file) => `  ${file.name}: ${file.bytes} bytes`).join("\n")}`,
    );
}
