import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveCLIConfig } from "../src/config.js";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
it("resolves the real Varlock schema into explicit values without changing process.env", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".shownotes-config-"));
  dirs.push(dir);
  await writeFile(join(dir, ".env.schema"), await readFile(".env.schema", "utf8"));
  await writeFile(
    join(dir, ".env.local"),
    (await readFile(".env.example", "utf8")).replace(
      /ANTHROPIC_API_KEY=.*/,
      "ANTHROPIC_API_KEY=synthetic-test-key",
    ),
  );
  const before = { ...process.env };
  const log = vi.spyOn(console, "log");
  const error = vi.spyOn(console, "error");
  const config = await resolveCLIConfig(dir, {});
  expect(config.apiKey).toBe("synthetic-test-key");
  expect(config.env.CLAUDE_MODEL).toBe("claude-haiku-4-5-20251001");
  expect(config.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(process.env).toEqual(before);
  expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(
    "synthetic-test-key",
  );
});
it("resolves dependencies of selected CLI keys", async () => {
  const dir = await mkdtemp(join(process.cwd(), ".shownotes-config-"));
  dirs.push(dir);
  const schema =
    (await readFile(".env.schema", "utf8")).replace("WHISPER_MODEL=", "WHISPER_MODEL=$MODEL_PATH") +
    "\nMODEL_PATH=/synthetic/model\n";
  await writeFile(join(dir, ".env.schema"), schema);
  const config = await resolveCLIConfig(dir, { ANTHROPIC_API_KEY: "synthetic-key" });
  expect(config.env.WHISPER_MODEL).toBe("/synthetic/model");
});
it("reports authorization timeout without exposing the underlying resolver message", async () => {
  const { internal } = await import("varlock");
  const dir = await mkdtemp(join(process.cwd(), ".shownotes-config-"));
  dirs.push(dir);
  await writeFile(join(dir, ".env.schema"), await readFile(".env.schema", "utf8"));
  const graph = await internal.loadEnvGraph({
    basePath: dir,
    skipCache: true,
    overrideValues: { ANTHROPIC_API_KEY: "synthetic" },
    processEnvOverride: {},
  });
  vi.spyOn(graph, "resolveEnvValues").mockImplementation(async () => {
    graph.configSchema.ANTHROPIC_API_KEY!.resolutionError = new internal.ResolutionError(
      "1Password CLI error - authorization timeout PRIVATE_TEST_VALUE",
    );
  });
  vi.spyOn(internal, "loadEnvGraph").mockResolvedValueOnce(graph);
  let failure: unknown;
  try {
    await resolveCLIConfig(dir, {});
  } catch (error) {
    failure = error;
  }
  expect((failure as Error).message).toContain("1Password authorization timed out");
  expect((failure as Error).message).not.toContain("PRIVATE_TEST_VALUE");
});
