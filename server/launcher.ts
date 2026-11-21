// How the packaged app opens: in its own window (Edge, Chrome or another Chromium browser in app mode: no tabs or
// address bar, its own profile in the data folder), or as a tab in the default browser: the travelers choose (settings).
// Links clicked in the own window open in the default browser (/api/open). The app quits once its last window closes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type WindowMode, readSettings } from "./settings";
import { allClosed } from "./util/activity";

const CANDIDATES: Record<string, string[]> = {
  win32: [
    `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser", "/snap/bin/chromium"],
};

/** The browser for an app window: TRIP_PLANNER_BROWSER (also used by tests, with TRIP_PLANNER_BROWSER_ARGS for extra
 *  flags), else the first Chromium browser found; null if there's none. */
export function appBrowser() {
  if (process.env.TRIP_PLANNER_BROWSER) return process.env.TRIP_PLANNER_BROWSER;
  return (CANDIDATES[process.platform] || []).find((p) => p && !p.startsWith("undefined") && fs.existsSync(p)) || null;
}
const extraArgs = () => (process.env.TRIP_PLANNER_BROWSER_ARGS || "").split(/\s+/).filter(Boolean);

/** Is the app already running on this port? Then a second start just opens another tab. */
export async function alreadyRunning(url: string) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return ((await res.json()) as { app?: string }).app === "trip-planner";
  } catch { return false; }
}

/** Opens the app. The browser is started on its own (detached): on Windows, programs started normally are closed
 *  together with the program that started them, which would take the window down when a second launch exits. */
export function openWindow(url: string, dataDir: string, mode: WindowMode = readSettings().window) {
  const browser = mode === "app" ? appBrowser() : null;
  if (!browser) return openInBrowser(url);
  const [cmd, args] = [browser, [`--app=${url}${url.includes("?") ? "&" : "?"}window=app`, `--user-data-dir=${path.join(dataDir, "window")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1500,950", ...extraArgs()]] as const;
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/** Opens a web address in the default browser (only http and https). */
export function openInBrowser(url: string) {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return false;
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  return true;
}

/** Quits a few seconds after the last tab or window closed (not on a reload), once nothing is running. */
export function quitWhenClosed(quit: () => void) {
  setInterval(() => { if (allClosed(5000)) quit(); }, 2000).unref();
}
