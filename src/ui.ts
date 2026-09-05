import type { DiagnosticInfo } from "./diagnostics.js";
import type { Brief } from "./distillation.js";
import { chaptersText, descriptionText } from "./render.js";
export function initUI(
  doc: Document,
  deps: {
    copy: (text: string) => Promise<void>;
    fetch: typeof fetch;
    confirm?: (message: string) => boolean;
  },
) {
  function element<T extends HTMLElement>(id: string): T {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`Missing UI element ${id}`);
    return el as T;
  }
  const status = element("copy-status");
  const error = element("error");
  const progress = element("progress");
  let current: Brief | undefined;
  let titleIndex: number | undefined;
  let descriptionIndex: number | undefined;
  let selectedFile: File | undefined;
  let working = false;
  const copyTitle = element<HTMLButtonElement>("copy-title");
  const copyDescription = element<HTMLButtonElement>("copy-description");
  const fileInput = element<HTMLInputElement>("video");
  const generate = element<HTMLButtonElement>("generate");
  const includeChapters = element<HTMLInputElement>("include-chapters");
  const chapterCount = element<HTMLSelectElement>("chapter-count");
  const chapterMinimum = element<HTMLInputElement>("chapter-min-seconds");
  function updateChapterControls() {
    includeChapters.disabled = working;
    chapterCount.disabled = working || !includeChapters.checked;
    chapterMinimum.disabled = working || !includeChapters.checked;
  }
  includeChapters.addEventListener("change", updateChapterControls);
  updateChapterControls();
  async function copy(text: string) {
    try {
      await deps.copy(text);
      status.textContent = "Copied to clipboard.";
    } catch {
      status.textContent = "Could not copy. Select the text above and copy it manually.";
    }
  }
  copyTitle.addEventListener("click", () => {
    if (current && titleIndex !== undefined) void copy(current.titles[titleIndex]!);
  });
  copyDescription.addEventListener("click", () => {
    if (current && descriptionIndex !== undefined)
      void copy(descriptionText(current, descriptionIndex));
  });
  element("copy-chapters").addEventListener("click", () => {
    if (current) void copy(chaptersText(current));
  });
  element("copy-tags").addEventListener("click", () => {
    if (current) void copy(current.tags.join(", "));
  });
  function showResult(brief: Brief) {
    current = brief;
    titleIndex = undefined;
    descriptionIndex = undefined;
    copyTitle.disabled = true;
    copyDescription.disabled = true;
    status.textContent = "";
    for (const [id, name, items] of [
      ["titles", "title", brief.titles],
      ["descriptions", "description", brief.descriptions.map((d) => d.join("\n\n"))],
    ] as const) {
      const container = element(id);
      container.replaceChildren();
      items.forEach((text, i) => {
        const label = doc.createElement("label");
        label.className = "choice";
        const radio = doc.createElement("input");
        radio.type = "radio";
        radio.name = name;
        radio.value = String(i);
        const content = doc.createElement("span");
        content.textContent = text;
        label.append(radio, content);
        container.append(label);
        radio.addEventListener("change", () => {
          if (name === "title") {
            titleIndex = i;
            copyTitle.disabled = false;
          } else {
            descriptionIndex = i;
            copyDescription.disabled = false;
          }
        });
      });
    }
    element("chapter-section").hidden = brief.chapters.length === 0;
    element<HTMLButtonElement>("copy-chapters").disabled = brief.chapters.length === 0;
    element("description-hint").textContent = brief.chapters.length
      ? "Includes the chapter list, ready for YouTube’s description field."
      : "Ready for YouTube’s description field.";
    element("chapters").textContent = chaptersText(brief);
    element("tags").textContent = brief.tags.join(", ");
    element("results").hidden = false;
    element("result-heading").focus();
  }
  function choose(file: File | undefined) {
    if (working) return;
    selectedFile = file;
    error.textContent = "";
    element("file-name").textContent = file
      ? `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB`
      : "Choose one MP4 recording";
  }
  fileInput.addEventListener("change", () => choose(fileInput.files?.[0]));
  const dropzone = element("dropzone");
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    if (working) return;
    const files = event.dataTransfer?.files;
    if (files?.length !== 1) {
      choose(undefined);
      fileInput.value = "";
      error.textContent = "Choose exactly one MP4 file.";
      return;
    }
    choose(files[0]);
    fileInput.required = false;
  });
  element("upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (working) return;
    const file = selectedFile;
    if (!file || !file.name.toLowerCase().endsWith(".mp4")) {
      error.textContent = "Choose one MP4 recording.";
      return;
    }
    working = true;
    updateChapterControls();
    generate.disabled = true;
    fileInput.disabled = true;
    element<HTMLInputElement>("reuse").disabled = true;
    error.textContent = "";
    element("results").hidden = true;
    element("progress-panel").hidden = false;
    element("progress-bar").hidden = false;
    progress.textContent = "Uploading to your local workspace…";
    const token = doc.querySelector<HTMLMetaElement>('meta[name="session-token"]')?.content ?? "";
    try {
      const response = await deps.fetch(
        `/api/jobs?name=${encodeURIComponent(file.name)}&reuse=${element<HTMLInputElement>("reuse").checked}&chapters=${includeChapters.checked}${includeChapters.checked ? `&chapterCount=${encodeURIComponent(chapterCount.value)}&chapterMinSeconds=${encodeURIComponent(chapterMinimum.value)}` : ""}`,
        {
          method: "POST",
          headers: { "content-type": "video/mp4", "x-session-token": token },
          body: file,
        },
      );
      const created = await response.json();
      if (!response.ok) throw new Error(created.error ?? "Upload failed.");
      for (;;) {
        const poll = await deps.fetch(`/api/jobs/${created.id}`, {
          headers: { "x-session-token": token },
        });
        const job = await poll.json();
        if (!poll.ok) throw new Error(job.error ?? "Could not read progress.");
        progress.textContent = job.stage;
        if (job.status === "error") throw new Error(job.error);
        if (job.status === "complete") {
          showResult(job.brief);
          element("saved").textContent =
            `${job.reused ? "Transcript reused. " : ""}Saved to ${job.prefix}.brief.md`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not process recording.";
      progress.textContent = "Stopped. Your existing outputs are preserved.";
    } finally {
      working = false;
      updateChapterControls();
      generate.disabled = false;
      fileInput.disabled = false;
      element<HTMLInputElement>("reuse").disabled = false;
      element("progress-bar").hidden = true;
    }
  });
  const diagnosticStatus = element("diagnostic-status");
  const reviewDiagnostics = element<HTMLButtonElement>("review-diagnostics");
  const diagnosticHeaders = () => ({
    "x-session-token":
      doc.querySelector<HTMLMetaElement>('meta[name="session-token"]')?.content ?? "",
  });
  async function refreshDiagnostics() {
    reviewDiagnostics.disabled = true;
    try {
      const response = await deps.fetch("/api/diagnostics", { headers: diagnosticHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not list diagnostics.");
      const list = element("diagnostic-list");
      list.replaceChildren();
      const runs = data.runs as DiagnosticInfo[];
      for (const run of runs) {
        const row = doc.createElement("li");
        const details = doc.createElement("p");
        details.textContent = `${run.id} · scope ${run.scope} · ${run.state} · ${run.bytes} bytes\n${run.files.map((file) => `${file.name}: ${file.bytes} bytes`).join(" · ")}`;
        row.append(details);
        if (run.state === "retained") {
          const remove = doc.createElement("button");
          remove.type = "button";
          remove.textContent = "Delete this diagnostic run";
          remove.addEventListener("click", async () => {
            const message = `Delete diagnostic run ${run.id} in scope ${run.scope} (${run.bytes} bytes)? This removes its raw Whisper JSON/TXT and diagnostic metadata only; saved transcripts and briefs are preserved.`;
            const confirmed = deps.confirm
              ? deps.confirm(message)
              : doc.defaultView?.confirm(message);
            if (!confirmed) return;
            remove.disabled = true;
            try {
              const result = await deps.fetch(
                `/api/diagnostics?scope=${encodeURIComponent(run.scope)}&id=${encodeURIComponent(run.id)}`,
                { method: "DELETE", headers: diagnosticHeaders() },
              );
              const body = await result.json();
              if (!result.ok) throw new Error(body.error ?? "Could not delete diagnostics.");
              await refreshDiagnostics();
              diagnosticStatus.textContent = `Deleted diagnostic run ${run.id}.`;
            } catch (cause) {
              diagnosticStatus.textContent =
                cause instanceof Error ? cause.message : "Could not delete diagnostics.";
              remove.disabled = false;
            }
          });
          row.append(remove);
        }
        list.append(row);
      }
      diagnosticStatus.textContent = runs.length
        ? `${runs.length} diagnostic runs. Active runs are protected.`
        : "No diagnostic runs retained.";
    } catch (cause) {
      diagnosticStatus.textContent =
        cause instanceof Error ? cause.message : "Could not list diagnostics.";
    } finally {
      reviewDiagnostics.disabled = false;
    }
  }
  reviewDiagnostics.addEventListener("click", () => {
    void refreshDiagnostics();
  });
  return { showResult };
}
if (typeof document !== "undefined")
  initUI(document, {
    fetch: globalThis.fetch.bind(globalThis),
    copy: (text) => navigator.clipboard.writeText(text),
  });
