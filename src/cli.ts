#!/usr/bin/env node
import { parseOptions, help } from "./options.js";
import { pipeline, productionDependencies } from "./pipeline.js";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const options = parseOptions(process.argv.slice(2), process.env);
  if (options.help) console.log(help);
  else {
    const result = await pipeline(
      { ...options, onProgress: (stage) => console.error(stage) },
      productionDependencies(
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_MODEL,
        controller.signal,
      ),
    );
    console.log(`Saved ${result.prefix}.brief.md`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not generate shownotes.");
  process.exitCode = 1;
}
