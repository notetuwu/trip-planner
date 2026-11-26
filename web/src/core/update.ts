// The "new version available" bar of the packaged app: install it (Windows) or open the download page (macOS, Linux).
// "Later" hides that version; the bar comes back for the next one.
import { api, esc } from "./dom";
import { ext } from "./icons";

export interface UpdateInfo { newer: boolean; current?: string; latest?: string; notesUrl?: string; mode?: "installer" | "portable" | "manual"; error?: string }
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

/** Update now, or rolling back to an older version (Windows): downloads and installs it, with the progress in the bar at
 *  the top. */
export async function install(info: UpdateInfo, rollback = false) {
  if (rollback) bar(`<span>Looking for Trip Planner ${esc(info.latest)}…</span>`);
  try {
    if (rollback) await api("/api/update/rollback", { method: "POST", body: JSON.stringify({ version: info.latest }) });
    else await api("/api/update", { method: "POST" });
  } catch (e) { bar(`<span>Couldn't ${rollback ? "roll back" : "update"}: ${esc((e as Error).message)}</span>`); return; }
  for (;;) {
    const s = await api<UpdateStatus>("/api/update/status").catch(() => null);
    // Restarting: "installing", gone for a moment, or already the new version back saying "idle" (the restart can be
    // quicker than this check, so the "installing" moment is easy to miss).
    if (!s || s.phase === "installing" || s.phase === "idle") break;
    if (s.phase === "error") { bar(`<span>${rollback ? "Rolling back" : "Update"} failed: ${esc(s.error)}</span> <a href="${esc(info.notesUrl)}" target="_blank" rel="noopener">Download it instead${ext()}</a>`); return; }
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
    <a href="${esc(info.notesUrl)}" target="_blank" rel="noopener">What's new${ext()}</a>
    <button class="link-btn" data-later>Later</button>`);
  el.querySelector<HTMLButtonElement>("[data-later]")!.onclick = () => { localStorage.setItem(DISMISSED, info.latest!); el.remove(); };
  el.querySelector<HTMLButtonElement>("[data-update]")!.onclick = () => {
    if (auto) install(info); else window.open(info.notesUrl, "_blank", "noopener");
  };
}

/** A little after start (so it doesn't compete with loading the trip), then every 30 minutes while open and when you
 *  come back to the window after a while. This only asks the app; the app asks GitHub at most once an hour. */
let lastCheck = 0;

declare const __APP_VERSION__: string;
/** The version in the header, linking to its release notes. */
function showVersion() {
  const el = document.getElementById("appVersion") as HTMLAnchorElement | null;
  if (!el) return;
  el.textContent = `v${__APP_VERSION__}`;
  el.href = `https://github.com/notetuwu/trip-planner/releases/tag/v${__APP_VERSION__}`;
  el.title = "This version's release notes";
}
const checkNow = () => { if (!document.getElementById("updateBar")) { lastCheck = Date.now(); checkForUpdates(); } };
export const initUpdates = () => {
  showVersion();
  setTimeout(checkNow, 3000);
  setInterval(checkNow, 30 * 60e3);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastCheck > 30 * 60e3) checkNow(); });
};
