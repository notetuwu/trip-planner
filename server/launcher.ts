// How the packaged app opens: in its own window (Edge, Chrome or another Chromium browser in app mode: no tabs or
// address bar, its own profile in the data folder), or as a tab in the default browser: the travelers choose (settings).
// Links clicked in the own window open in the default browser (/api/open). The app quits once its last window closes.
import { execFile, spawn } from "node:child_process";
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
  if (!/^https?:\/\/[^\s"]+$/i.test(url)) return false;
  if (process.platform !== "win32") {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    return true;
  }
  // Windows: start the default browser itself with the link, using the command it registered for web links. Going
  // through Windows' URL handling instead can send some sites to an app registered for them ("Apps for websites"),
  // and when that app is gone Windows reports it "cannot find" the address (seen with Google Maps links).
  defaultBrowserCommand().then((cmd) => {
    const [exe, args] = cmd ? fillCommand(cmd, url) : ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
    spawn(exe, args, { stdio: "ignore", detached: true }).unref();
    if (cmd) bringToFront(path.basename(exe, path.extname(exe)));
  });
  return true;
}

// Windows only lets the program you're using bring a window to the front; the planner's server runs in the background,
// so the browser would open the link in a tab but stay behind. A short hidden PowerShell step brings its window up
// (restoring it if minimized); the Alt key tap is the usual way to be allowed to do that.
const FRONT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Milliseconds 500
Add-Type -Namespace TP -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
'@
$p = Get-Process -Name $env:TP_BROWSER | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $h = $p.MainWindowHandle
  if ([TP.W]::IsIconic($h)) { [void][TP.W]::ShowWindow($h, 9) }
  [TP.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [TP.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][TP.W]::SetForegroundWindow($h)
}`;

export function bringToFront(processName: string) {
  if (process.platform !== "win32" || !/^[\w .-]+$/.test(processName)) return;
  const encoded = Buffer.from(FRONT_SCRIPT, "utf16le").toString("base64");
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { stdio: "ignore", detached: true, windowsHide: true, env: { ...process.env, TP_BROWSER: processName } }).unref();
}

let browserCommand: Promise<string | null> | null = null;

/** The default browser's registered command for https links, e.g. "C:\…\zen.exe" -osint -url "%1" (null if unknown). */
function defaultBrowserCommand() {
  const reg = (args: string[]) => new Promise<string>((resolve) =>
    execFile("reg", ["query", ...args], { windowsHide: true, timeout: 3000 }, (err, out) => resolve(err ? "" : String(out))));
  browserCommand ||= (async () => {
    const progId = (await reg(["HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"]))
      .match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1];
    if (!progId) return null;
    const cmd = (await reg([`HKCR\\${progId}\\shell\\open\\command`, "/ve"])).match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim();
    // Expand %VARIABLES% (but not %1, the link).
    return cmd ? cmd.replace(/%([A-Za-z_][\w()]*)%/g, (m, name) => process.env[name] ?? m) : null;
  })().catch(() => null);
  return browserCommand;
}

/** Splits a registered command into program and arguments, with the link in place of %1 (or added at the end). */
export function fillCommand(cmd: string, url: string): [string, string[]] {
  const parts = [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  let used = false;
  const args = parts.slice(1).map((p) => (/%[1lL]/.test(p) ? ((used = true), p.replace(/%[1lL]/, url)) : p));
  return [parts[0], used ? args : [...args, url]];
}

/** Quits a few seconds after the last tab or window closed (not on a reload), once nothing is running. */
export function quitWhenClosed(quit: () => void) {
  setInterval(() => { if (allClosed(5000)) quit(); }, 2000).unref();
}
