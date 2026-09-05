import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createLocalServer } from "../src/server.js";
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
