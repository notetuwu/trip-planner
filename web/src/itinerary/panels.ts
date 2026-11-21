// The collapsible "Reasoning" and "Prompt sent to the model" panels, used live while generating and afterwards.
import { esc } from "../core/dom";
import type { Lookup, PromptPart } from "../core/state";

/** The model's planning notes are light Markdown: paragraphs, "- " bullets, **bold**, # headings. */
export function mdLite(text: string | undefined) {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  return String(text || "").trim().split(/\n\s*\n/).map((block) => {
    // Some models put several bullets on one line ("- a - b - c"); give each its own line.
    const lines = block.split("\n").flatMap((l) => (/^\s*- /.test(l) ? l.split(/\s+-\s+(?=\S)/).map((p, i) => (i ? `- ${p}` : p)) : [l]));
    if (lines.every((l) => /^\s*[-*•] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•] /, ""))}</li>`).join("")}</ul>`;
    if (/^#{1,6} /.test(lines[0]) && lines.length === 1) return `<p><b>${inline(lines[0].replace(/^#+ /, ""))}</b></p>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

/** Planning notes, plus the raw thinking when a local model shares it, and what was looked up online. */
export const thoughtsBody = (notes: string | undefined, thinking = "", lookups: Lookup[] = []) =>
  (thinking ? `<div class="raw-thinking"><b>Thinking</b>${esc(thinking)}</div>` : "") +
  (lookups.length ? `<div class="lookups"><b>Looked up online (${lookups.length})</b><ul>${lookups.map((l) => `<li>${l.url
    ? `📄 <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70))}</a>`
    : `🔍 ${esc(l.query)}`}</li>`).join("")}</ul></div>` : "") +
  mdLite(notes);

export const thoughtsHtml = (notes: string | undefined, { thinking = "", lookups = [] as Lookup[], live = false } = {}) => `
  <details class="thoughts">
    <summary>Reasoning${lookups.length ? ` · ${lookups.length} lookups` : ""}${live ? ` <span class="hint" data-thoughts-hint>appears as the model writes it</span>` : ""}</summary>
    <div class="thoughts-body" data-thoughts-body>${thoughtsBody(notes, thinking, lookups)}</div>
  </details>`;

/** Everything handed to the model: the prompt(s), plus every search result and page it was given while researching. */
export const promptSummary = (parts: PromptPart[]) =>
  `Prompt sent to the model · ${parts.length > 1 ? `${parts.length} parts · ` : ""}${parts.reduce((n, p) => n + p.text.length, 0).toLocaleString()} characters`;
export const promptBody = (parts: PromptPart[]) => parts.map((p) => `
  <div class="prompt-part">
    <b>${esc(p.label)}</b>${p.info ? `<div class="hint">${esc(p.info)}</div>` : ""}
    <pre>${esc(p.text)}</pre>
  </div>`).join("");
export const promptHtml = (parts: PromptPart[]) => `
  <details class="thoughts prompt-panel">
    <summary data-prompt-summary>${promptSummary(parts)}</summary>
    <div class="thoughts-body" data-prompt-body>${promptBody(parts)}</div>
  </details>`;
