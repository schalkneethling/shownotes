import { afterEach, expect, it, vi } from "vitest";
const maintenance = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/diagnostics-cli.js", () => ({ runDiagnosticsCommand: maintenance }));
const config = vi.hoisted(() => vi.fn());
const runPipeline = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({ resolveCLIConfig: config }));
vi.mock("../src/pipeline.js", () => ({
  pipeline: runPipeline,
  productionDependencies: (_key: string, _model: string, signal: AbortSignal) => ({ signal }),
}));
const originalArgs = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExitCode;
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

it("installs working cancellation handlers only after credentials resolve", async () => {
  process.argv = ["node", "cli.js", "recording.mp4"];
  const once = vi.spyOn(process, "once").mockReturnValue(process);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const handlers = () =>
    once.mock.calls.filter(([name]) => name === "SIGINT" || name === "SIGTERM");
  config.mockImplementation(async () => {
    expect(handlers()).toEqual([]);
    return { apiKey: "synthetic", env: {} };
  });
  const abort = vi.spyOn(AbortController.prototype, "abort");
  runPipeline.mockImplementation(async (_options, deps) => {
    expect(handlers().map(([name]) => name)).toEqual(["SIGINT", "SIGTERM"]);
    for (const [, handler] of handlers()) handler();
    expect(abort).toHaveBeenCalledTimes(2);
    expect(deps.signal.aborted).toBe(true);
    return { prefix: "synthetic" };
  });
  await import("../src/cli.js");
  expect(runPipeline).toHaveBeenCalledTimes(1);
});
