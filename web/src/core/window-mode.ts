// The packaged app opens in its own window or as a browser tab (switch in Settings → General). In its own window, links to
// other sites open in the default browser instead of another app window.
import { api } from "./dom";
import { askConfirm, tell } from "./ask";

const KEY = "trip-planner-app-window";
// The launcher opens the own window with ?window=app; remember it for reloads and tidy the address.
if (new URLSearchParams(location.search).get("window") === "app") {
  sessionStorage.setItem(KEY, "1");
  const u = new URL(location.href); u.searchParams.delete("window");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
export const inAppWindow = sessionStorage.getItem(KEY) === "1";

/** What the planner is shown in: "Own window · WebView2 158", "Browser tab · Firefox 140"… */
export function engineText() {
  const ua = navigator.userAgent, nav = navigator as Navigator & { brave?: unknown; userAgentData?: { brands: { brand: string }[] } };
  const chromium = ua.match(/(?:Chrome|Edg)\/(\d+)/)?.[1] || "";
  const brands = nav.userAgentData?.brands.map((b) => b.brand) || [];
  const engine = (window as Window & { chrome?: { webview?: unknown } }).chrome?.webview ? `WebView2 ${chromium}`
    : nav.brave ? "Brave"
    : brands.includes("Microsoft Edge") ? `Edge ${chromium}`
    : brands.includes("Google Chrome") ? `Chrome ${chromium}`
    : /Firefox\/(\d+)/.test(ua) ? `Firefox ${ua.match(/Firefox\/(\d+)/)![1]}`
    : /Version\/[\d.]+ .*Safari/.test(ua) ? "Safari"
    : chromium ? `Chromium ${chromium}` : "a browser";
  return `${inAppWindow ? "Own window" : "Browser tab"} · ${engine.trim()}`;
}

const external = (href: string) => /^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin;
/** Opens a link outside the app: in the default browser (from a phone, a new tab). */
export const openOutside = (url: string) => api("/api/open", { method: "POST", body: JSON.stringify({ url }) }).catch(() => window.open(url, "_blank"));

function sendLinksToBrowser() {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.hasAttribute("download") || !external(a.href)) return;
    e.preventDefault();
    openOutside(a.href);
  };
  document.addEventListener("click", onClick);
  document.addEventListener("auxclick", onClick);
  const open = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    if (url && external(String(url))) { openOutside(new URL(String(url), location.href).href); return null; }
    return open(url, target, features);
  };
}

/** Settings → General "Opens in": saves the choice and offers to switch now (reopening the app that way). */
export async function switchWindowMode(mode: "app" | "browser") {
  const here = inAppWindow ? "app" : "browser";
  const reopen = mode !== here && await askConfirm({ title: "Switch now?", text: `The planner opens ${mode === "app" ? "in its own window" : "in a browser tab"} and this ${here === "app" ? "window" : "tab"} closes.`, ok: "Switch now", cancel: "Later" });
  await api("/api/settings", { method: "POST", body: JSON.stringify({ window: mode, reopen }) });
  if (reopen) { window.close(); setTimeout(() => tell({ title: "Switched", text: "You can close this tab now." }), 800); }
  return reopen;
}

/** A browser's app window (Edge) while the app could have its own (WebView2): from before an update that brought it, which
 *  only reloaded the window that was open. It opens the app's own window and closes itself, once per version. */
async function moveToOwnWindow() {
  if ((window as Window & { chrome?: { webview?: unknown } }).chrome?.webview) return;
  const s = await api<{ ownWindow?: boolean; window?: string; version?: string }>("/api/settings").catch(() => null);
  if (!s?.ownWindow || s.window !== "app" || localStorage.getItem(MOVED) === s.version) return;
  localStorage.setItem(MOVED, s.version || "");
  await api("/api/settings", { method: "POST", body: JSON.stringify({ reopen: true }) }).catch(() => {});
  setTimeout(() => window.close(), 1500);
}
const MOVED = "trip-planner-moved-to-own-window";

export function initWindowMode() {
  if (inAppWindow) { sendLinksToBrowser(); moveToOwnWindow(); }
}
