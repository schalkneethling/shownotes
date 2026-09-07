import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiagnosticRun,
  finishDiagnosticRun,
  listDiagnostics,
  deleteDiagnosticRun,
} from "../src/diagnostics.js";
import { runDiagnosticsCommand } from "../src/diagnostics-cli.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const out = await mkdtemp(join(tmpdir(), "shownotes-diag-test-"));
  dirs.push(out);
  return out;
}
it("lists metadata only and deletes one retained run without touching saved outputs", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await writeFile(join(run.path, "whisper.txt"), "PRIVATE_TRANSCRIPT_TEST");
  await writeFile(join(out, "final.transcript.txt"), "saved");
  await finishDiagnosticRun(run, true);
  const list = await listDiagnostics(out);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: run.id, scope: ".", state: "retained" });
  expect(list[0]?.files).toContainEqual({ name: "whisper.txt", bytes: 23 });
  expect(JSON.stringify(list)).not.toContain("PRIVATE_TRANSCRIPT_TEST");
  await deleteDiagnosticRun(out, ".", run.id);
  expect(await listDiagnostics(out)).toEqual([]);
  expect(await readFile(join(out, "final.transcript.txt"), "utf8")).toBe("saved");
});
it("protects active runs and removes successful-run scratch through the internal lifecycle", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow("active");
  await finishDiagnosticRun(run, false);
  expect(await listDiagnostics(out)).toEqual([]);
});
it("finds web runs in immediate video-hash directories", async () => {
  const out = await setup();
  const scope = "a".repeat(64);
  await mkdir(join(out, scope));
  const run = await createDiagnosticRun(join(out, scope));
  await finishDiagnosticRun(run, true);
  expect((await listDiagnostics(out))[0]?.scope).toBe(scope);
  await deleteDiagnosticRun(out, scope, run.id);
  expect(await listDiagnostics(out)).toEqual([]);
});
it.each([
  { scope: "..", id: "run-test" },
  { scope: ".", id: "../saved" },
  { scope: ".", id: "/tmp/saved" },
])("rejects traversal inputs", async ({ scope, id }) => {
  await expect(deleteDiagnosticRun(await setup(), scope, id)).rejects.toThrow("Invalid diagnostic");
});
it("refuses an unowned diagnostics root", async () => {
  const out = await setup();
  await mkdir(join(out, ".whisper-diagnostics"));
  await expect(createDiagnosticRun(out)).rejects.toThrow("ownership");
  await expect(listDiagnostics(out)).rejects.toThrow("ownership");
});
it("refuses symlink roots, scopes, runs, and files", async () => {
  const outside = await setup();
  const protectedRun = await createDiagnosticRun(outside);
  await writeFile(join(protectedRun.path, "whisper.txt"), "saved");
  await finishDiagnosticRun(protectedRun, true);
  const out = await setup();
  await symlink(join(outside, ".whisper-diagnostics"), join(out, ".whisper-diagnostics"));
  await expect(listDiagnostics(out)).rejects.toThrow("symlink");
  await rm(join(out, ".whisper-diagnostics"));
  const own = await createDiagnosticRun(out);
  await finishDiagnosticRun(own, true);
  await rm(own.path, { recursive: true });
  await symlink(protectedRun.path, own.path);
  await expect(deleteDiagnosticRun(out, ".", own.id)).rejects.toThrow("symlink");
  const scope = "b".repeat(64);
  await symlink(outside, join(out, scope));
  await expect(deleteDiagnosticRun(out, scope, protectedRun.id)).rejects.toThrow("symlink");
  const clean = await setup();
  const fileRun = await createDiagnosticRun(clean);
  await finishDiagnosticRun(fileRun, true);
  await symlink(join(protectedRun.path, "whisper.txt"), join(fileRun.path, "whisper.txt"));
  await expect(deleteDiagnosticRun(clean, ".", fileRun.id)).rejects.toThrow("symlink");
  expect(await readFile(join(protectedRun.path, "whisper.txt"), "utf8")).toBe("saved");
});
it("refuses unknown files instead of deleting final artifacts", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  await writeFile(join(run.path, "final.brief.md"), "saved");
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow("unrecognized");
  expect(await readFile(join(run.path, "final.brief.md"), "utf8")).toBe("saved");
});
it("rejects invalid run ownership metadata", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  await writeFile(join(run.path, "run.json"), "{}");
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow("metadata");
});
it("CLI lists first and deletes only after explicit --delete invocation", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  const lines: string[] = [];
  await runDiagnosticsCommand(["--out", out], (line) => {
    lines.push(line);
  });
  expect(lines.join("\n")).toContain(run.id);
  expect(await readdir(run.path)).toContain("run.json");
  await runDiagnosticsCommand(["--out", out, "--delete", run.id], (line) => {
    lines.push(line);
  });
  expect(await listDiagnostics(out)).toEqual([]);
  expect(lines.join("\n")).toContain("Deleted");
  await expect(runDiagnosticsCommand(["--all"], () => {})).rejects.toThrow();
});
