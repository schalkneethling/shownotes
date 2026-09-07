import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import {
  createDiagnosticRun,
  finishDiagnosticRun,
  listDiagnostics,
  deleteDiagnosticRun,
} from "../src/diagnostics.js";
import { pipeline } from "../src/pipeline.js";
import { TranscriptionOutputError } from "../src/transcription.js";
const faults = vi.hoisted(() => ({
  afterRead: undefined as undefined | ((path: string) => Promise<void>),
  scratch: false,
  beforeOpen: undefined as undefined | ((path: string, flags: unknown) => Promise<void>),
  beforeUnlink: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (faults.beforeOpen) await faults.beforeOpen(String(args[0]), args[1]);
      return real.open(...args);
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      const hook = faults.beforeUnlink;
      faults.beforeUnlink = undefined;
      if (hook) await hook();
      return real.unlink(...args);
    },
    readdir: async (...args: Parameters<typeof real.readdir>) => {
      const result = await real.readdir(...args);
      const hook = faults.afterRead;
      faults.afterRead = undefined;
      if (hook) await hook(String(args[0]));
      return result;
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (faults.scratch && String(args[0]).split("/").at(-1)?.startsWith(".shownotes-"))
        throw new Error("Synthetic audio cleanup failure");
      return real.rm(...args);
    },
  };
});
const dirs: string[] = [];
async function setup() {
  const dir = await fs.mkdtemp(join(tmpdir(), "shownotes-review-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  faults.afterRead = undefined;
  faults.beforeOpen = undefined;
  faults.beforeUnlink = undefined;
  faults.scratch = false;
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
it("ignores a run that disappears after directory enumeration", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  faults.afterRead = async () => {
    faults.afterRead = async () => {
      await fs.rm(run.path, { recursive: true });
    };
  };
  expect(await listDiagnostics(out)).toEqual([]);
});
it("does not swallow malformed metadata during listing", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await fs.writeFile(join(run.path, "run.json"), "{}");
  await expect(listDiagnostics(out)).rejects.toThrow("metadata");
});
it.each(["output", "root", "run"])("refuses a group-writable %s directory", async (which) => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  await fs.chmod(
    which === "output" ? out : which === "root" ? join(out, ".whisper-diagnostics") : run.path,
    0o770,
  );
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow("permissions");
  expect(await fs.readFile(join(run.path, "run.json"), "utf8")).toContain("retained");
});
it("finishes diagnostics and preserves the original failure when audio cleanup fails", async () => {
  const out = await setup();
  const input = join(out, "clip.mp4");
  const model = join(out, "model");
  await fs.writeFile(input, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
  await fs.writeFile(model, "synthetic");
  faults.scratch = true;
  const result = pipeline(
    { input, out, model, binary: "synthetic" },
    {
      check: async () => {},
      extract: async () => {},
      transcribe: async () => {
        throw new TranscriptionOutputError("json", "Synthetic malformed Whisper JSON");
      },
      distill: vi.fn(),
    },
  );
  await expect(result).rejects.toThrow(
    /Synthetic malformed Whisper JSON[\s\S]*Whisper diagnostic directory:[\s\S]*Synthetic audio cleanup failure/,
  );
  expect((await listDiagnostics(out))[0]?.state).toBe("retained");
});

it("refuses metadata replaced by a symlink before retention write", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  const target = join(out, "protected.txt");
  await fs.writeFile(target, "saved");
  faults.beforeOpen = async (path, flags) => {
    if (
      path === join(run.path, "run.json") &&
      typeof flags === "number" &&
      flags & constants.O_RDWR
    ) {
      faults.beforeOpen = undefined;
      await fs.unlink(path);
      await fs.symlink(target, path);
    }
  };
  await expect(finishDiagnosticRun(run, true)).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toBe("saved");
});
it("leaves a newly appeared unrecognized subtree untouched during deletion", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  faults.beforeUnlink = async () => {
    await fs.mkdir(join(run.path, "unexpected"));
    await fs.writeFile(join(run.path, "unexpected", "saved"), "saved");
  };
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow();
  expect(await fs.readFile(join(run.path, "unexpected", "saved"), "utf8")).toBe("saved");
});
it("rejects a writable ancestor above the output directory", async () => {
  const parent = await setup();
  const out = join(parent, "output");
  await fs.mkdir(out, { mode: 0o700 });
  const run = await createDiagnosticRun(out);
  await finishDiagnosticRun(run, true);
  await fs.chmod(parent, 0o770);
  await expect(deleteDiagnosticRun(out, ".", run.id)).rejects.toThrow("ancestor");
});
it("preserves missing metadata errors when the run still exists", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  await fs.unlink(join(run.path, "run.json"));
  await expect(listDiagnostics(out)).rejects.toThrow();
});
it("preserves permission errors when inspecting a listed run", async () => {
  const out = await setup();
  const run = await createDiagnosticRun(out);
  faults.beforeOpen = async (path) => {
    if (path === join(run.path, "run.json"))
      throw Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" });
  };
  await expect(listDiagnostics(out)).rejects.toThrow("metadata");
});
