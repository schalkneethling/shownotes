#!/usr/bin/env node
import { parseOptions, help } from "./options.js";
import { pipeline, productionDependencies } from "./pipeline.js";
import { runDiagnosticsCommand } from "./diagnostics-cli.js";
import { resolveCLIConfig } from "./config.js";
try {
  if (process.argv[2] === "diagnostics") await runDiagnosticsCommand(process.argv.slice(3));
  else {
    let options = parseOptions(process.argv.slice(2), process.env);
    if (options.help) console.log(help);
    else {
      const config = await resolveCLIConfig();
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      options = parseOptions(process.argv.slice(2), config.env);
      const result = await pipeline(
        { ...options, onProgress: (stage) => console.error(stage) },
        productionDependencies(config.apiKey, config.env.CLAUDE_MODEL, controller.signal),
      );
      console.log(`Saved ${result.prefix}.brief.md`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not generate shownotes.");
  process.exitCode = 1;
}
