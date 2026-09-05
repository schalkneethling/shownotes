import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get, type Server } from "node:http";
import { createLocalServer } from "../src/server.js";
import { createDiagnosticRun, finishDiagnosticRun, listDiagnostics } from "../src/diagnostics.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "shownotes-server-"));
  const processVideo = vi.fn(
    async (input: string, out: string, reuse: boolean, progress: (s: string) => void) => {
      progress("Transcribing locally");
      return {
        brief: {
          titles: ["1", "2", "3", "4", "5"],
          descriptions: [
            ["a", "b"],
            ["c", "d"],
          ],
          chapters: [],
          tags: [],
        },
        prefix: join(out, "recording"),
        reused: reuse,
      };
    },
  );
  const server: Server = createLocalServer({ out: dir, maxBytes: 1024, processVideo });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  const html = await (await fetch(url)).text();
  const token = /name="session-token" content="([^"]+)"/.exec(html)?.[1] ?? "";
  return { dir, url, token, processVideo };
}
it("serves a usable accessible upload form without any API key", async () => {
  const s = await setup();
  const res = await fetch(s.url);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('type="file"');
  expect(s.token).not.toBe("");
});
it("rejects cross-origin and tokenless requests", async () => {
  const s = await setup();
  expect(
    (
      await fetch(`${s.url}/api/jobs?name=a.mp4`, {
        method: "POST",
        headers: { "content-type": "video/mp4" },
        body: "x",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${s.url}/api/jobs?name=a.mp4`, {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          "x-session-token": s.token,
          origin: "https://evil.example",
        },
        body: "x",
      })
    ).status,
  ).toBe(403);
});
it("rejects invalid type, traversal names and oversized uploads", async () => {
  const s = await setup();
  for (const [name, type, body, status] of [
    ["a.txt", "text/plain", "x", 400],
    ["../a.mp4", "video/mp4", "x", 400],
    ["a.mp4", "video/mp4", "x".repeat(1025), 413],
  ] as const) {
    expect(
      (
        await fetch(`${s.url}/api/jobs?name=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { "content-type": type, "x-session-token": s.token },
          body,
        })
      ).status,
    ).toBe(status);
  }
  expect(s.processVideo).not.toHaveBeenCalled();
});
it("streams a synthetic MP4, returns progress/result and removes uploaded raw media", async () => {
  const s = await setup();
  const body = Buffer.from([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112,
    52, 50,
  ]);
  const response = await fetch(`${s.url}/api/jobs?name=recording.mp4&reuse=true`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-session-token": s.token },
    body,
  });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  let job: { status: string; brief?: unknown } = { status: "running" };
  for (let i = 0; i < 50 && job.status === "running"; i++) {
    job = (await (
      await fetch(`${s.url}/api/jobs/${id}`, { headers: { "x-session-token": s.token } })
    ).json()) as typeof job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(job.status).toBe("complete");
  expect(job.brief).toBeDefined();
  expect(s.processVideo).toHaveBeenCalledTimes(1);
  expect((await readdir(s.dir)).some((name) => name.startsWith(".upload-"))).toBe(false);
});

it("accepts both exact loopback Host/Origin names and rejects suffixes and wrong ports", async () => {
  const s = await setup();
  const port = new URL(s.url).port;
  const getStatus = (headers: Record<string, string>) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = get(s.url, { headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
    });
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
    for (const origin of [s.url, `http://localhost:${port}`]) {
      expect(await getStatus({ host, origin })).toBe(200);
    }
  for (const host of [`localhost.evil:${port}`, `127.0.0.1.evil:${port}`, "localhost:1"])
    expect(await getStatus({ host })).toBe(403);
  for (const origin of [
    `http://localhost.evil:${port}`,
    "http://localhost:1",
    `https://localhost:${port}`,
    "null",
  ])
    expect(await getStatus({ origin })).toBe(403);
});
it("guards diagnostic listing/deletion and protects active runs", async () => {
  const s = await setup();
  const run = await createDiagnosticRun(s.dir);
  const endpoint = `${s.url}/api/diagnostics?scope=.&id=${run.id}`;
  expect((await fetch(endpoint)).status).toBe(403);
  expect(
    (
      await fetch(endpoint, {
        method: "DELETE",
        headers: { "x-session-token": s.token, origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  const headers = { "x-session-token": s.token };
  expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(400);
  await finishDiagnosticRun(run, true);
  const listed = (await (await fetch(`${s.url}/api/diagnostics`, { headers })).json()) as {
    runs: unknown[];
  };
  expect(listed.runs).toHaveLength(1);
  expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(200);
  expect(await listDiagnostics(s.dir)).toEqual([]);
});
it("rejects diagnostic deletion while a recording job is busy", async () => {
  const s = await setup();
  const run = await createDiagnosticRun(s.dir);
  await finishDiagnosticRun(run, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.processVideo.getMockImplementation()!;
  s.processVideo.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  try {
    const body = Buffer.from([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112,
      52, 50,
    ]);
    const headers = { "x-session-token": s.token };
    await fetch(`${s.url}/api/jobs?name=test.mp4`, {
      method: "POST",
      headers: { ...headers, "content-type": "video/mp4" },
      body,
    });
    expect(
      (await fetch(`${s.url}/api/diagnostics?scope=.&id=${run.id}`, { method: "DELETE", headers }))
        .status,
    ).toBe(409);
  } finally {
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
});
it.each([
  { query: "chapters=false", settings: { enabled: false, minDurationSeconds: 10 } },
  {
    query: "chapters=true&chapterCount=3&chapterMinSeconds=5",
    settings: { enabled: true, count: 3, minDurationSeconds: 5 },
  },
])(
  "passes chapter settings from upload to the shared pipeline: $query",
  async ({ query, settings }) => {
    const s = await setup();
    const body = Buffer.from([
      0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112,
      52, 50,
    ]);
    const response = await fetch(`${s.url}/api/jobs?name=clip.mp4&${query}`, {
      method: "POST",
      headers: { "content-type": "video/mp4", "x-session-token": s.token },
      body,
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(s.processVideo).toHaveBeenCalled());
    expect(s.processVideo).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      false,
      expect.any(Function),
      settings,
    );
  },
);
it("rejects invalid chapter settings before processing the upload", async () => {
  const s = await setup();
  const response = await fetch(`${s.url}/api/jobs?name=clip.mp4&chapterCount=99`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "x-session-token": s.token },
    body: "synthetic",
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("Chapter count");
  expect(s.processVideo).not.toHaveBeenCalled();
});
