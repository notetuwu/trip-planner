// The usage lines under the Model menu for Claude: the plan's limits (as Claude Code's /usage shows them), or with an
// Anthropic API key the per-minute limits of its last answer. Looks like Gemini's line (gemini-panel.ts).
import type { UsageInfo, UsageLimit } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { ext, icon } from "../core/icons";
import { resets } from "../trip/usage-banner";

const money = (n: number, currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).format(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function line(text: string, percent: number, near: boolean, after = "") {
  const tone = percent >= 100 ? " full" : near || percent >= 80 ? " near" : "";
  return `<span class="gm-q${tone}">${text} <span class="gm-bar"><i style="width:${Math.min(100, percent)}%"></i></span>${after}</span>`;
}

const limitLine = (l: UsageLimit) => line(`${esc(cap(l.name))}: ${Math.floor(l.percent)}% used`, l.percent, !!l.near, l.resetsAt ? ` · ${esc(resets(l.resetsAt))}` : "");

/** The lines for a model, or "" when nothing is known. */
export async function claudeLines(model: string) {
  const info = await api<UsageInfo>(`/api/usage?model=${encodeURIComponent(model)}`).catch(() => null);
  const u = info?.limits;
  if (!u) return "";
  const x = u.extra;
  return [
    `<span class="gm-q">${icon("sparkles")} <b>${esc(u.title)}</b>${u.note ? `: ${esc(u.note)}` : ""} · <a href="${esc(u.url)}" target="_blank" rel="noopener">View usage${ext()}</a></span>`,
    ...u.list.map(limitLine),
    ...(x ? [line(`Extra usage: ${esc(money(x.used, x.currency))} of ${esc(money(x.cap, x.currency))}`, (x.used / x.cap) * 100, false)] : []),
  ].join("<br>");
}
