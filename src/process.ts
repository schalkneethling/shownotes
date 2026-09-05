import { spawn } from "node:child_process";
export type RunProcess = (binary: string, args: string[], signal?: AbortSignal) => Promise<void>;
export const runProcess: RunProcess = (binary, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      signal,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        SystemRoot: process.env.SystemRoot,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === "ENOENT"
            ? `Missing dependency: ${binary}. Install it and ensure it is on PATH.`
            : `Cannot start ${binary}: ${error.message}`,
        ),
      ),
    );
    child.on("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${binary} failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${stderr.trim()}`,
            ),
          ),
    );
  });
