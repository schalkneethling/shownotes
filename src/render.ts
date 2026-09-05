import type { Brief } from "./distillation.js";
export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`
    : `${String(minutes).padStart(2, "0")}:${seconds}`;
}
export function chaptersText(brief: Brief): string {
  return brief.chapters.map((c) => `${formatTimestamp(c.startMs)} ${c.title}`).join("\n");
}
export function renderBrief(brief: Brief): string {
  return `# YouTube brief\n\n## Title (default: candidate 1)\n\n${brief.titles[0]}\n\n## Description (default: candidate 1)\n\n${brief.descriptions[0]?.join("\n\n")}\n\n${chaptersText(brief)}\n\n## Tags\n\n${brief.tags.join(", ")}\n\n## All title candidates\n\n${brief.titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n## Alternative description\n\n${brief.descriptions[1]?.join("\n\n")}\n`;
}
