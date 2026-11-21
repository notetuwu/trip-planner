// The "new version available" bar of the packaged app: install it (Windows) or open the download page (macOS, Linux).
// "Later" hides that version; the bar comes back for the next one.
import { api, esc } from "./dom";

interface UpdateInfo { newer: boolean; current?: string; latest?: string; notesUrl?: string; mode?: "installer" | "portable" | "manual"; error?: string }
interface UpdateStatus { phase: "idle" | "downloading" | "installing" | "error"; received: number; total: number; error?: string }

const DISMISSED = "trip-planner-update-dismissed";
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

function bar(html: string) {
  let el = document.getElementById("updateBar");
  if (!el) {
    el = document.createElement("div");
    el.id = "updateBar";
    el.className = "update-bar";
    document.body.prepend(el);
  }
  el.innerHTML = html;
  return el;
}

/** Waits for the new version to answer, then reloads the page into it. */
async function reloadWhenBack(from: string) {
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const h = await api<{ version: string }>("/api/health");
      if (h.version && h.version !== from) return location.reload();
    } catch { /* restarting */ }
  }
  bar(`<span>The update is taking long. Close this window and start Trip Planner again.</span>`);
}

async function install(info: UpdateInfo) {
  try { await api("/api/update", { method: "POST" }); } catch (e) { bar(`<span>Couldn't update: ${esc((e as Error).message)}</span>`); return; }
  for (;;) {
    const s = await api<UpdateStatus>("/api/update/status").catch(() => null);
    if (!s || s.phase === "installing") break; // the app is restarting
    if (s.phase === "error") { bar(`<span>Update failed: ${esc(s.error)}</span> <a href="${esc(info.notesUrl)}" target="_blank" rel="noopener">Download it instead ↗</a>`); return; }
    bar(`<span>Downloading Trip Planner ${esc(info.latest)}… ${mb(s.received)} of ${mb(s.total)}</span>`);
    await new Promise((r) => setTimeout(r, 500));
  }
  bar(`<span>Installing Trip Planner ${esc(info.latest)}… the app restarts in a moment.</span>`);
  reloadWhenBack(info.current || "");
}

export async function checkForUpdates() {
  const info = await api<UpdateInfo>("/api/update").catch(() => null);
  if (!info?.newer || !info.latest || localStorage.getItem(DISMISSED) === info.latest) return;
  const auto = info.mode === "installer" || info.mode === "portable";
  const el = bar(`<span>Trip Planner <b>${esc(info.latest)}</b> is available (you have ${esc(info.current)}).</span>
    <button class="btn solid" data-update>${auto ? "Update now" : "Download"}</button>
    <a href="${esc(info.notesUrl)}" target="_blank" rel="noopener">What's new ↗</a>
    <button class="link-btn" data-later>Later</button>`);
  el.querySelector<HTMLButtonElement>("[data-later]")!.onclick = () => { localStorage.setItem(DISMISSED, info.latest!); el.remove(); };
  el.querySelector<HTMLButtonElement>("[data-update]")!.onclick = () => {
    if (auto) install(info); else window.open(info.notesUrl, "_blank", "noopener");
  };
}

/** A little after start (so it doesn't compete with loading the trip), then every hour while open (the app itself asks GitHub at most once an hour). */
export const initUpdates = () => {
  setTimeout(checkForUpdates, 3000);
  setInterval(() => { if (!document.getElementById("updateBar")) checkForUpdates(); }, 3600e3);
};
