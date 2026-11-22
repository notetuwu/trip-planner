// The collapsible "Reasoning" and "Prompt sent to the model" panels, used live while generating and afterwards.
import { esc } from "../core/dom";
import type { Lookup, PromptPart } from "../core/state";
import { icon } from "../core/icons";

/** The model's planning notes are light Markdown: paragraphs, "- " bullets, **bold**, # headings. */
export function mdLite(text: string | undefined) {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const bullet = /^\s*(?:[-*•]|\d+[.)]) /;
  return String(text || "").trim().split(/\n\s*\n/).map((block) => {
    // Some models put several bullets on one line ("- a - b - c"); give each its own line.
    const lines = block.split("\n").flatMap((l) => (/^\s*- /.test(l) ? l.split(/\s+-\s+(?=\S)/).map((p, i) => (i ? `- ${p}` : p)) : [l]));
    if (/^#{1,6} /.test(lines[0]) && lines.length === 1) return `<p><b>${inline(lines[0].replace(/^#+ /, ""))}</b></p>`;
    // Runs of bullet lines become lists; the lines between them paragraphs ("On day 2:" then the bullets).
    let html = "", para: string[] = [], items: string[] = [];
    const flush = () => {
      if (para.length) html += `<p>${para.map((l) => inline(l.replace(/^#+ /, ""))).join("<br>")}</p>`;
      if (items.length) html += `<ul>${items.map((l) => `<li>${inline(l.replace(bullet, ""))}</li>`).join("")}</ul>`;
      para = []; items = [];
    };
    for (const l of lines) {
      if (bullet.test(l)) { if (para.length) { const p = para; para = []; html += `<p>${p.map(inline).join("<br>")}</p>`; } items.push(l); }
      else { if (items.length) flush(); para.push(l); }
    }
    flush();
    return html;
  }).join("");
}

/** Planning notes, plus the raw thinking when a local model shares it, and what was looked up online. */
export const thoughtsBody = (notes: string | undefined, thinking = "", lookups: Lookup[] = []) =>
  (thinking ? `<div class="raw-thinking"><b>Thinking</b>${esc(thinking)}</div>` : "") +
  (lookups.length ? `<div class="lookups"><b>Looked up online (${lookups.length})</b><ul>${lookups.map((l) => `<li>${l.url
    ? `${icon("file")} <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70))}</a>`
    : `${icon("search")} ${esc(l.query)}`}</li>`).join("")}</ul></div>` : "") +
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
