import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { initUI } from "../src/ui.js";
it("requires explicit candidate selection, copies selected text and reports clipboard failure", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"), {
    url: "http://127.0.0.1:4317",
  });
  const copy = vi.fn(async (_text: string) => {});
  const ui = initUI(dom.window.document, { copy, fetch: vi.fn() as unknown as typeof fetch });
  ui.showResult({
    titles: ["A", "B", "C", "D", "E"],
    descriptions: [
      ["First", "Second"],
      ["Other", "Ending"],
    ],
    chapters: [{ startMs: 0, title: "Intro" }],
    tags: ["web"],
  });
  const doc = dom.window.document;
  expect(doc.querySelectorAll('input[name="title"]')).toHaveLength(5);
  expect(doc.querySelectorAll('input[name="description"]')).toHaveLength(2);
  const button = doc.querySelector<HTMLButtonElement>("#copy-title")!;
  expect(button.disabled).toBe(true);
  const radio = doc.querySelector<HTMLInputElement>('input[name="title"][value="1"]')!;
  radio.click();
  expect(button.disabled).toBe(false);
  button.click();
  await Promise.resolve();
  expect(copy).toHaveBeenCalledWith("B");
  copy.mockRejectedValueOnce(new Error("denied"));
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(doc.querySelector("#copy-status")?.textContent).toContain("Could not copy");
  ui.showResult({
    titles: ["A", "B", "C", "D", "E"],
    descriptions: [
      ["First", "Second"],
      ["Other", "Ending"],
    ],
    chapters: [],
    tags: [],
  });
  expect(button.disabled).toBe(true);
});
it("renders model text as text, never HTML", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  const ui = initUI(dom.window.document, {
    copy: async () => {},
    fetch: vi.fn() as unknown as typeof fetch,
  });
  ui.showResult({
    titles: ["<img src=x onerror=alert(1)>", "B", "C", "D", "E"],
    descriptions: [
      ["a", "b"],
      ["c", "d"],
    ],
    chapters: [],
    tags: [],
  });
  expect(dom.window.document.querySelector("#titles img")).toBeNull();
});
it("submits a dropped file, polls progress and resets selection for a new result", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"), {
    url: "http://127.0.0.1:4317",
  });
  const brief = {
    titles: ["A", "B", "C", "D", "E"],
    descriptions: [
      ["a", "b"],
      ["c", "d"],
    ],
    chapters: [],
    tags: [],
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "test" })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "complete",
          stage: "Complete",
          brief,
          prefix: "/output/test",
          reused: true,
        }),
      ),
    );
  initUI(dom.window.document, { copy: async () => {}, fetch: request });
  const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { files: [new dom.window.File(["synthetic"], "demo.mp4", { type: "video/mp4" })] },
  });
  dom.window.document.querySelector("#dropzone")!.dispatchEvent(drop);
  dom.window.document
    .querySelector("#upload-form")!
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(dom.window.document.querySelector<HTMLElement>("#results")!.hidden).toBe(false),
  );
  expect(request.mock.calls[0]?.[0]).toContain("name=demo.mp4&reuse=true");
  expect(request).toHaveBeenCalledTimes(2);
  expect(dom.window.document.querySelector("#saved")?.textContent).toContain("Transcript reused");
});
it("clears a stale dropped file after a multi-file drop and reports upload errors", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  const request = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "Recording exceeds the upload limit." }), {
      status: 413,
    }),
  );
  initUI(dom.window.document, { copy: async () => {}, fetch: request });
  const drop = (files: File[]) => {
    const event = new dom.window.Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files } });
    dom.window.document.querySelector("#dropzone")!.dispatchEvent(event);
  };
  const file = new dom.window.File(["synthetic"], "demo.mp4", { type: "video/mp4" });
  drop([file]);
  drop([file, file]);
  const submit = () =>
    dom.window.document
      .querySelector("#upload-form")!
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  submit();
  expect(request).not.toHaveBeenCalled();
  drop([file]);
  submit();
  await vi.waitFor(() =>
    expect(dom.window.document.querySelector("#error")?.textContent).toContain("exceeds"),
  );
  expect(dom.window.document.querySelector<HTMLButtonElement>("#generate")!.disabled).toBe(false);
});

it("reviews diagnostic file sizes and requires confirmation before a cleanup request", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  const run = {
    id: "run-example",
    scope: ".",
    state: "retained",
    createdAt: "2026-09-05T00:00:00.000Z",
    bytes: 100,
    files: [{ name: "whisper.json", bytes: 100 }],
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [run] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [] })));
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  initUI(dom.window.document, { copy: async () => {}, fetch: request, confirm });
  dom.window.document.querySelector<HTMLButtonElement>("#review-diagnostics")!.click();
  await vi.waitFor(() =>
    expect(dom.window.document.querySelector("#diagnostic-list")?.textContent).toContain(
      "whisper.json: 100 bytes",
    ),
  );
  const remove = dom.window.document.querySelector<HTMLButtonElement>("#diagnostic-list button")!;
  remove.click();
  expect(request).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("saved transcripts and briefs"));
  remove.click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  expect(dom.window.document.querySelector("#diagnostic-status")?.textContent).toContain("Deleted");
});
it("does not offer diagnostic deletion for active runs", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  initUI(dom.window.document, {
    copy: async () => {},
    fetch: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          runs: [{ id: "active", scope: ".", state: "active", bytes: 0, files: [] }],
        }),
      ),
    ),
  });
  dom.window.document.querySelector<HTMLButtonElement>("#review-diagnostics")!.click();
  await vi.waitFor(() =>
    expect(dom.window.document.querySelector("#diagnostic-list")?.textContent).toContain("active"),
  );
  expect(dom.window.document.querySelector("#diagnostic-list button")).toBeNull();
});
it("hides chapter controls/results and copies a clean description when chapters are omitted", async () => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  const doc = dom.window.document;
  const copy = vi.fn(async () => {});
  const ui = initUI(doc, { copy, fetch: vi.fn() as unknown as typeof fetch });
  const include = doc.querySelector<HTMLInputElement>("#include-chapters")!;
  include.click();
  expect(doc.querySelector<HTMLSelectElement>("#chapter-count")!.disabled).toBe(true);
  expect(doc.querySelector<HTMLInputElement>("#chapter-min-seconds")!.disabled).toBe(true);
  ui.showResult({
    titles: ["A", "B", "C", "D", "E"],
    descriptions: [
      ["First", "Second"],
      ["Other", "Ending"],
    ],
    chapters: [],
    tags: ["web"],
  });
  expect(doc.querySelector<HTMLElement>("#chapter-section")!.hidden).toBe(true);
  doc.querySelector<HTMLInputElement>('input[name="description"][value="0"]')!.click();
  doc.querySelector<HTMLButtonElement>("#copy-description")!.click();
  await Promise.resolve();
  expect(copy).toHaveBeenCalledWith("First\n\nSecond");
});
it.each([false, true])("submits chosen chapter settings (include: %s)", async (enabled) => {
  const dom = new JSDOM(await readFile("public/index.html", "utf8"));
  const doc = dom.window.document;
  const request = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ error: "Synthetic stop" }), { status: 400 }));
  initUI(doc, { copy: async () => {}, fetch: request });
  if (!enabled) doc.querySelector<HTMLInputElement>("#include-chapters")!.click();
  doc.querySelector<HTMLSelectElement>("#chapter-count")!.value = "3";
  doc.querySelector<HTMLInputElement>("#chapter-min-seconds")!.value = "5";
  const drop = new dom.window.Event("drop", { cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { files: [new dom.window.File(["synthetic"], "clip.mp4")] },
  });
  doc.querySelector("#dropzone")!.dispatchEvent(drop);
  doc
    .querySelector("#upload-form")!
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const url = new URL(request.mock.calls[0]![0], "http://localhost");
  expect(url.searchParams.get("chapters")).toBe(String(enabled));
  if (enabled) {
    expect(url.searchParams.get("chapterCount")).toBe("3");
    expect(url.searchParams.get("chapterMinSeconds")).toBe("5");
  }
  await vi.waitFor(() =>
    expect(doc.querySelector<HTMLButtonElement>("#generate")!.disabled).toBe(false),
  );
});
