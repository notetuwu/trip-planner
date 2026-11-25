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

const external = (href: string) => /^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin;
const openOutside = (url: string) => api("/api/open", { method: "POST", body: JSON.stringify({ url }) }).catch(() => window.open(url, "_blank"));

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

export function initWindowMode() {
  if (inAppWindow) sendLinksToBrowser();
}
