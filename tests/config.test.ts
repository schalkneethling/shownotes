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
