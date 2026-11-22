// The packaged app opens in its own window or as a browser tab (switch in the header). In its own window, links to
// other sites open in the default browser instead of another app window.
import { api } from "./dom";

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

interface WindowSettings { window: "app" | "browser"; packaged: boolean; appWindow: boolean }

/** The "Opens in" switch: only in the packaged app, and only when there's a browser that can make an app window. */
async function windowSwitch() {
  const s = await api<WindowSettings>("/api/settings").catch(() => null);
  if (!s?.packaged || !s.appWindow) return;
  const el = document.createElement("label");
  el.className = "window-mode";
  el.title = "How the planner opens when you start it";
  el.innerHTML = `<span>Opens in</span> <select><option value="app">its own window</option><option value="browser">a browser tab</option></select>`;
  const select = el.querySelector("select")!;
  select.value = s.window;
  select.onchange = async () => {
    const mode = select.value;
    const here = inAppWindow ? "app" : "browser";
    const reopen = mode !== here && confirm(`Switch now? The planner opens ${mode === "app" ? "in its own window" : "in a browser tab"} and this ${here === "app" ? "window" : "tab"} closes.`);
    await api("/api/settings", { method: "POST", body: JSON.stringify({ window: mode, reopen }) });
    if (reopen) { window.close(); setTimeout(() => alert("Switched. You can close this tab now."), 800); }
  };
  document.querySelector("#appVersion")?.after(el);
}

export function initWindowMode() {
  if (inAppWindow) sendLinksToBrowser();
  windowSwitch();
}
