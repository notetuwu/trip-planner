// The small status pill in the map's corner ("Locating 41 places…"). Clicked, it opens into a panel over the map that
// shows what the place lookups are doing: what each service is looking up now, what's next, which service is left out
// (not answering), and what happened lately (found, not found, failed, handed to the other service).
import { $, api, esc } from "../core/dom";
import { icon } from "../core/icons";

interface GeoEvent { at: number; q: string; lane: "nominatim" | "photon"; result: "found" | "none" | "error" | "moved"; name?: string; error?: string; ms: number }
interface GeoStatus {
  queued: number;
  waiting: { q: string; lane: string }[];
  now: { lane: string; q: string; since: number }[];
  down: { lane: string; until: number }[];
  events: GeoEvent[];
}

const LANE: Record<string, string> = { nominatim: "Nominatim", photon: "Photon" };
let open = false, timer: number | undefined, text = "";

const root = () => $("#mapStatus");

/** Sets the pill's text; empty hides it (and closes the panel). */
export function setMapStatus(msg: string) {
  text = msg;
  const el = root();
  el.hidden = !msg;
  if (!msg && open) toggle(false);
  const pill = el.querySelector(".ms-text");
  if (pill) pill.textContent = msg;
  else {
    el.innerHTML = `<button type="button" class="ms-pill" title="Show what it's doing"><span class="ms-dot"></span><span class="ms-text">${esc(msg)}</span>${icon("arrowUpRight", "ms-open")}</button>
      <div class="ms-panel" aria-live="polite"></div>`;
    el.querySelector<HTMLButtonElement>(".ms-pill")!.onclick = () => toggle(!open);
  }
}

function toggle(on: boolean) {
  open = on;
  root().classList.toggle("open", on);
  // As tall as the map allows (it opens upwards from the pill).
  const panel = root().querySelector<HTMLElement>(".ms-panel"), map = root().parentElement;
  if (panel && map) panel.style.maxHeight = `${Math.max(160, Math.min(460, map.clientHeight - 56))}px`;
  clearInterval(timer);
  if (on) { refresh(); timer = window.setInterval(refresh, 1000); }
}

const ago = (ms: number) => (ms < 60e3 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60e3)} min`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function refresh() {
  const s = await api<GeoStatus>("/api/geocode/status").catch(() => null);
  const panel = root().querySelector<HTMLElement>(".ms-panel");
  if (!panel || !open) return;
  if (!s) { panel.innerHTML = `<p class="hint">Can't reach the planner for the status.</p>`; return; }
  const result = (e: GeoEvent) => e.result === "found" ? `<span class="ms-r ok">${icon("check")}</span>`
    : e.result === "none" ? `<span class="ms-r none">${icon("x")}</span>`
    : e.result === "moved" ? `<span class="ms-r moved">${icon("arrowLeftRight")}</span>`
    : `<span class="ms-r err">${icon("warn")}</span>`;
  const detail = (e: GeoEvent) => e.result === "found" ? esc(e.name || "found")
    : e.result === "none" ? "not found"
    : e.result === "moved" ? `not found by ${LANE[e.lane]}, asking ${LANE[e.lane === "photon" ? "nominatim" : "photon"]}`
    : `failed: ${esc(e.error || "error")}`;
  panel.innerHTML = `
    <div class="ms-head"><b>${esc(text || "Place lookups")}</b><button type="button" class="icon-btn ms-close" title="Close">${icon("x")}</button></div>
    ${s.down.map((d) => `<div class="ms-down">${icon("warn")} ${LANE[d.lane]} isn't answering from here, so only ${LANE[d.lane === "photon" ? "nominatim" : "photon"]} is asked until ${clock(d.until)}.</div>`).join("")}
    <div class="ms-sec">Now</div>
    ${s.now.length ? s.now.map((n) => `<div class="ms-row"><span class="ms-lane">${LANE[n.lane]}</span><span class="ms-q">${esc(n.q)}</span><span class="ms-ms">${ago(Date.now() - n.since)}</span></div>`).join("")
      : `<div class="hint ms-row">Nothing being looked up right now.</div>`}
    ${s.queued ? `<div class="ms-sec">Next up · ${s.queued} waiting</div>${s.waiting.map((w) => `<div class="ms-row muted"><span class="ms-lane">${LANE[w.lane] || ""}</span><span class="ms-q">${esc(w.q)}</span></div>`).join("")}` : ""}
    <div class="ms-sec">Lately</div>
    ${s.events.length ? s.events.map((e) => `<div class="ms-row">${result(e)}<span class="ms-q"><b>${esc(e.q)}</b><small>${LANE[e.lane]} · ${detail(e)}</small></span><span class="ms-ms">${(e.ms / 1000).toFixed(1)} s</span></div>`).join("")
      : `<div class="hint ms-row">No lookups yet.</div>`}`;
  panel.querySelector<HTMLButtonElement>(".ms-close")!.onclick = () => toggle(false);
}
