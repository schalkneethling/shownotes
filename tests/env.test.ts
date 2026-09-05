import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { internal } from "varlock";
it("parses the real Varlock schema and op resolver without fetching any vault values", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".shownotes-schema-"));
  try {
    await writeFile(join(dir, ".env.schema"), await readFile(".env.schema", "utf8"));
    await writeFile(join(dir, ".env.local"), await readFile(".env.example", "utf8"));
    const graph = await internal.loadEnvGraph({
      basePath: dir,
      skipCache: true,
      checkGitIgnored: false,
      overrideValues: { ANTHROPIC_API_KEY: "synthetic-test-only" },
      processEnvOverride: {},
    });
    await graph.resolveEnvValues();
    expect(graph.configSchema.ANTHROPIC_API_KEY?.resolvedValue).toBe("synthetic-test-only");
    expect(graph.configSchema.ANTHROPIC_API_KEY?.isSensitive).toBe(true);
    expect(Object.values(graph.configSchema).every((item) => item.isValid)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
