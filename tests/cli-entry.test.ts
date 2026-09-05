import { afterEach, expect, it, vi } from "vitest";
const maintenance = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/diagnostics-cli.js", () => ({ runDiagnosticsCommand: maintenance }));
const originalArgs = process.argv;
afterEach(() => {
  process.argv = originalArgs;
  vi.restoreAllMocks();
  vi.resetModules();
});
it("does not install pipeline cancellation handlers for diagnostic maintenance", async () => {
  process.argv = ["node", "cli.js", "diagnostics", "--help"];
  const once = vi.spyOn(process, "once");
  await import("../src/cli.js");
  expect(maintenance).toHaveBeenCalledWith(["--help"]);
  expect(once.mock.calls.filter(([name]) => name === "SIGINT" || name === "SIGTERM")).toEqual([]);
});
