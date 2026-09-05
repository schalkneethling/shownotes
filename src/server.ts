import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, validateMp4 } from "./pipeline.js";
import { listDiagnostics, deleteDiagnosticRun } from "./diagnostics.js";
import type { Brief } from "./distillation.js";
import { parseChapterSettings, type ChapterSettings } from "./chapters.js";
interface Job {
  status: "running" | "complete" | "error";
  stage: string;
  brief?: Brief;
  error?: string;
  prefix?: string;
  reused?: boolean;
}
export interface ServerOptions {
  out: string;
  maxBytes?: number;
  processVideo: (
    input: string,
    out: string,
    reuse: boolean,
    progress: (stage: string) => void,
    chapters: ChapterSettings,
  ) => Promise<{ brief: Brief; prefix: string; reused: boolean }>;
}
export function createLocalServer(options: ServerOptions) {
  const token = randomBytes(32).toString("hex");
  const jobs = new Map<string, Job>();
  let busy = false;
  const maxBytes = options.maxBytes ?? 4 * 1024 ** 3;
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }
  const server = createServer(
    { requestTimeout: 30 * 60 * 1000, headersTimeout: 30000 },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const host = `127.0.0.1:${port}`;
      const origin = `http://${host}`;
      const allowedHosts = new Set([host, `localhost:${port}`]);
      const allowedOrigins = new Set([origin, `http://localhost:${port}`]);
      if (
        !allowedHosts.has(req.headers.host ?? "") ||
        (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      ) {
        json(res, 403, { error: "This service only accepts same-origin loopback requests." });
        return;
      }
      let scratch: string | undefined;
      let ownsBusy = false;
      try {
        const url = new URL(req.url ?? "/", origin);
        const assets: Record<string, [string, string]> = {
          "/": ["../public/index.html", "text/html; charset=utf-8"],
          "/style.css": ["../public/style.css", "text/css"],
          "/ui.js": ["./ui.js", "text/javascript"],
          "/render.js": ["./render.js", "text/javascript"],
        };
        if (req.method === "GET" && assets[url.pathname]) {
          const [path, type] = assets[url.pathname]!;
          let body = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
          if (url.pathname === "/")
            body = body
              .replace("SESSION_TOKEN", token)
              .replace("MAX_UPLOAD", String(Math.floor(maxBytes / 1024 ** 2)));
          res.writeHead(200, { "content-type": type });
          res.end(body);
          return;
        }
        if (req.headers["x-session-token"] !== token) {
          json(res, 403, { error: "Reload the page to establish a local session." });
          return;
        }
        if (url.pathname === "/api/diagnostics" && req.method === "GET") {
          json(res, 200, { runs: await listDiagnostics(options.out) });
          return;
        }
        if (url.pathname === "/api/diagnostics" && req.method === "DELETE") {
          if (busy) {
            json(res, 409, {
              error: "Wait for the active recording job before deleting diagnostics.",
            });
            return;
          }
          await deleteDiagnosticRun(
            options.out,
            url.searchParams.get("scope") ?? ".",
            url.searchParams.get("id") ?? "",
          );
          json(res, 200, { deleted: true });
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
          const job = jobs.get(url.pathname.slice("/api/jobs/".length));
          json(
            res,
            job ? 200 : 404,
            job ?? { error: "Job not found. Keep this page open while processing." },
          );
          return;
        }
        if (req.method !== "POST" || url.pathname !== "/api/jobs") {
          json(res, 404, { error: "Not found" });
          return;
        }
        if (busy) {
          json(res, 409, { error: "A recording is already processing. Wait for it to finish." });
          return;
        }
        const chapters = parseChapterSettings({
          enabled: url.searchParams.get("chapters") ?? undefined,
          count: url.searchParams.get("chapterCount") ?? undefined,
          minDurationSeconds: url.searchParams.get("chapterMinSeconds") ?? undefined,
        });
        const name = url.searchParams.get("name") ?? "";
        if (
          !name ||
          name !== basename(name) ||
          name.includes("\\") ||
          [...name].some((char) => char.charCodeAt(0) < 32) ||
          name.length > 200 ||
          !name.toLowerCase().endsWith(".mp4") ||
          req.headers["content-type"] !== "video/mp4"
        ) {
          json(res, 400, { error: "Choose one MP4 file with a valid filename." });
          return;
        }
        const length = Number(req.headers["content-length"]);
        if (Number.isFinite(length) && length > maxBytes) {
          json(res, 413, { error: "Recording exceeds the upload limit." });
          return;
        }
        busy = true;
        ownsBusy = true;
        await mkdir(options.out, { recursive: true, mode: 0o700 });
        scratch = await mkdtemp(join(options.out, ".upload-"));
        const input = join(scratch, name);
        const file = await open(input, "wx", 0o600);
        let bytes = 0;
        try {
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error("Recording exceeds the upload limit.");
            await file.writeFile(chunk);
          }
        } finally {
          await file.close();
        }
        await validateMp4(input);
        const digest = await hashFile(input);
        const out = join(options.out, digest);
        if (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
        const id = randomUUID();
        const job: Job = { status: "running", stage: "Recording received" };
        jobs.set(id, job);
        const uploadDir = scratch;
        scratch = undefined;
        ownsBusy = false;
        json(res, 202, { id });
        void (async () => {
          try {
            const result = await options.processVideo(
              input,
              out,
              url.searchParams.get("reuse") === "true",
              (stage) => {
                job.stage = stage;
              },
              chapters,
            );
            Object.assign(job, result);
            job.stage = "Cleaning temporary upload";
          } catch (error) {
            job.stage = "Could not finish";
            job.error = error instanceof Error ? error.message : "Processing failed.";
          } finally {
            await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
            busy = false;
            job.status = job.error ? "error" : "complete";
            if (!job.error) job.stage = "Complete";
          }
        })();
      } catch (error) {
        if (!res.headersSent)
          json(res, 400, { error: error instanceof Error ? error.message : "Upload failed." });
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
        if (ownsBusy) busy = false;
      }
    },
  );
  return server;
}
