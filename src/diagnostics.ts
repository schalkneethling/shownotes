import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { constants } from "node:fs";
const rootName = ".whisper-diagnostics";
const ownership = "shownotes-whisper-diagnostics-v1\n";
const idPattern = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const scopePattern = /^[0-9a-f]{64}$/;
const manifestSchema = z.object({
  owner: z.literal("shownotes"),
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  state: z.enum(["active", "retained"]),
});
export interface DiagnosticRun {
  out: string;
  id: string;
  path: string;
}
export interface DiagnosticInfo {
  id: string;
  scope: string;
  createdAt: string;
  state: "active" | "retained";
  files: { name: string; bytes: number }[];
  bytes: number;
}
async function checkDirectory(path: string, optional = false): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (info.isSymbolicLink()) throw new Error("Refusing diagnostic symlink directory.");
  if (!info.isDirectory()) throw new Error("Invalid diagnostic directory.");
  if (!process.getuid || info.uid !== process.getuid() || info.mode & 0o022)
    throw new Error("Unsafe diagnostic directory ownership or permissions.");
  return true;
}
// Canonical ancestors must not let another user replace a checked directory.
// Sticky ancestors (such as /tmp) protect entries owned by this user.
async function checkAncestors(path: string): Promise<void> {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (
      !process.getuid ||
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid()) ||
      (info.mode & 0o022 && !(info.mode & 0o1000))
    )
      throw new Error("Unsafe diagnostic ancestor ownership or permissions.");
    if (dirname(parent) === parent) break;
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readRegular(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !process.getuid ||
      info.uid !== process.getuid() ||
      info.mode & 0o022
    )
      throw new Error("Unsafe diagnostic file ownership or permissions.");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
async function removeRun(root: string, info: DiagnosticInfo): Promise<void> {
  const path = join(root, info.id);
  for (const file of info.files) await unlink(join(path, file.name));
  await rmdir(path);
}
async function regularFile(path: string) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Refusing diagnostic symlink file.");
  if (!info.isFile()) throw new Error("Unrecognized diagnostic file type.");
  if (!process.getuid || info.uid !== process.getuid() || info.mode & 0o022 || info.nlink !== 1)
    throw new Error("Unsafe diagnostic file ownership or permissions.");
  return info;
}
async function ownedRoot(out: string, create = false): Promise<string | undefined> {
  if (!(await checkDirectory(resolve(out), !create))) return;
  const canonical = await realpath(out);
  await checkAncestors(canonical);
  const root = join(canonical, rootName);
  if (create) {
    try {
      await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, ".owner"), ownership, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  if (!(await checkDirectory(root, true))) return;
  try {
    await regularFile(join(root, ".owner"));
    if ((await readRegular(join(root, ".owner"))) !== ownership) throw new Error();
  } catch {
    throw new Error("Unrecognized diagnostic root ownership; no files were changed.");
  }
  return root;
}
function validateSelection(scope: string, id: string) {
  if ((scope !== "." && !scopePattern.test(scope)) || !idPattern.test(id))
    throw new Error("Invalid diagnostic scope or run ID.");
}
async function inspectRun(root: string, id: string, scope: string): Promise<DiagnosticInfo> {
  validateSelection(scope, id);
  const path = join(root, id);
  await checkDirectory(path);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    await regularFile(join(path, "run.json"));
    manifest = manifestSchema.parse(JSON.parse(await readRegular(join(path, "run.json"))));
  } catch (error) {
    if (missing(error)) throw error;
    throw new Error("Invalid diagnostic run metadata; no files were changed.");
  }
  if (manifest.id !== id || !Number.isFinite(Date.parse(manifest.createdAt)))
    throw new Error("Invalid diagnostic run metadata; no files were changed.");
  const files: { name: string; bytes: number }[] = [];
  for (const name of await readdir(path)) {
    if (!["run.json", "whisper.json", "whisper.txt"].includes(name))
      throw new Error("Refusing unrecognized files in diagnostic run.");
    const info = await regularFile(join(path, name));
    files.push({ name, bytes: info.size });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    id,
    scope,
    createdAt: manifest.createdAt,
    state: manifest.state,
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}
export async function createDiagnosticRun(out: string): Promise<DiagnosticRun> {
  const root = await ownedRoot(out, true);
  if (!root) throw new Error("Missing diagnostic root.");
  const id = `run-${randomUUID()}`;
  const path = join(root, id);
  await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(path, "run.json"),
    JSON.stringify({
      owner: "shownotes",
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      state: "active",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return { out: await realpath(out), id, path };
}
export async function finishDiagnosticRun(run: DiagnosticRun, retain: boolean): Promise<void> {
  const root = await ownedRoot(run.out);
  if (!root) throw new Error("Missing diagnostic root.");
  const info = await inspectRun(root, run.id, ".");
  if (retain) {
    const file = await open(
      join(root, run.id, "run.json"),
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        !process.getuid ||
        stat.uid !== process.getuid() ||
        stat.mode & 0o022
      )
        throw new Error("Unsafe diagnostic metadata ownership or permissions.");
      const content = JSON.stringify({
        owner: "shownotes",
        version: 1,
        id: run.id,
        createdAt: info.createdAt,
        state: "retained",
      });
      await file.writeFile(content);
      await file.truncate(Buffer.byteLength(content));
    } finally {
      await file.close();
    }
  } else await removeRun(root, info);
}
export async function listDiagnostics(out: string): Promise<DiagnosticInfo[]> {
  if (!(await checkDirectory(resolve(out), true))) return [];
  const base = await realpath(out);
  const scopes = [".", ...(await readdir(base)).filter((name) => scopePattern.test(name))];
  const runs: DiagnosticInfo[] = [];
  for (const scope of scopes) {
    const root = await ownedRoot(scope === "." ? base : join(base, scope));
    if (!root) continue;
    for (const id of await readdir(root)) {
      if (id === ".owner") continue;
      try {
        runs.push(await inspectRun(root, id, scope));
      } catch (error) {
        if (missing(error) && !(await checkDirectory(join(root, id), true))) continue;
        throw error;
      }
    }
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function deleteDiagnosticRun(out: string, scope: string, id: string): Promise<void> {
  validateSelection(scope, id);
  await checkDirectory(resolve(out));
  const base = await realpath(out);
  const root = await ownedRoot(scope === "." ? base : join(base, scope));
  if (!root) throw new Error("Diagnostic run not found.");
  const info = await inspectRun(root, id, scope);
  if (info.state !== "retained") throw new Error("Cannot delete active diagnostic run.");
  await removeRun(root, info);
}
