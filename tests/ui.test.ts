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
