// A warning in a chat's message box (the trip chat, the route chat) while that chat model's usage is critical (a limit or credit nearly or
// fully used; what's known per service: server/ai/usage-notices.ts). Dismissed with ✕, it comes back when it changes.
import type { UsageNotice } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { ext, icon } from "../core/icons";

const DISMISSED = "trip-planner-usage-dismissed";
/** The newest question per box: an older answer arriving late is dropped. */
const asked = new Map<string, number>();

/** "resets 18:00", or with the day when it isn't today ("resets Tue, 1 Dec, 18:00"). */
function resets(at: number) {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return `resets ${d.toLocaleString([], today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export async function refreshUsageBanner(model: string, box = "#cpUsage") {
  const el = document.querySelector<HTMLElement>(box);
  if (!el) return;
  const mine = (asked.get(box) || 0) + 1;
  asked.set(box, mine);
  const n = await api<{ notice: UsageNotice | null }>(`/api/usage?model=${encodeURIComponent(model)}`).then((r) => r.notice, () => null);
  if (mine !== asked.get(box)) return;
  // The same warning (its words, level and reset) stays dismissed.
  const key = n ? `${n.level}|${n.text}|${n.resetsAt || ""}` : "";
  let gone = "";
  try { gone = sessionStorage.getItem(DISMISSED) || ""; } catch { /* private window */ }
  el.hidden = !n || key === gone;
  if (el.hidden) { el.innerHTML = ""; return; }
  el.className = `cp-usage ${n!.level}`;
  el.innerHTML = `${icon("warn")}<span>${esc(n!.text)}${n!.resetsAt ? ` · ${esc(resets(n!.resetsAt))}` : ""}${n!.url ? ` · <a href="${esc(n!.url)}" target="_blank" rel="noopener">View usage${ext()}</a>` : ""}</span>
    <button type="button" class="cp-usage-x" title="Dismiss">${icon("x")}</button>`;
  el.querySelector<HTMLButtonElement>(".cp-usage-x")!.onclick = () => {
    try { sessionStorage.setItem(DISMISSED, key); } catch { /* private window */ }
    el.hidden = true;
  };
}
