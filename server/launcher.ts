// The packaged app's window: Edge, Chrome or another Chromium browser in app mode (its own window, no tabs or address
// bar, its own profile in the data folder), else the default browser. The app quits when its window closes, or a few
// minutes after the page stopped checking in.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { idleFor, isBusy } from "./util/activity";

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

const findBrowser = () => (CANDIDATES[process.platform] || []).find((p) => p && !p.startsWith("undefined") && fs.existsSync(p)) || null;

/** Is the app already running on this port? Then a second start just opens another window. */
export async function alreadyRunning(url: string) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return ((await res.json()) as { app?: string }).app === "trip-planner";
  } catch { return false; }
}

/** Opens the app; returns the browser process when it got its own window (null for the default browser). */
export function openWindow(url: string, dataDir: string): ChildProcess | null {
  const browser = findBrowser();
  if (browser) {
    const profile = path.join(dataDir, "window");
    return spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1500,950"], { stdio: "ignore", detached: false });
  }
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  return null;
}

/** Quits when the window is closed, or when the page has been gone for a few minutes (e.g. a browser tab was closed). */
export function quitWhenClosed(window: ChildProcess | null, quit: () => void) {
  const started = Date.now();
  // A browser that was already running with this profile hands the window over and exits at once; that isn't a close.
  window?.on("exit", () => {
    if (Date.now() - started < 10000) return;
    setInterval(() => { if (!isBusy()) quit(); }, 3000); // let a running generation finish first
  });
  setInterval(() => { if (idleFor(3 * 60 * 1000)) quit(); }, 30000).unref();
}
