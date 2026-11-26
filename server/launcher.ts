// How the packaged app opens: in its own window, or as a tab in the default browser: the travelers choose (settings).
// The own window is WebView2 on Windows (window-host.ts). Elsewhere, and on a Windows without WebView2, it's a Chromium
// browser in app mode (Chrome, Brave, Chromium, else Edge: no tabs or address bar, its own profile in the data folder).
// Links clicked in the own window open in the default browser (/api/open). The app quits once its last window closes.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type WindowMode, readSettings } from "./settings";
import { allClosed } from "./util/activity";
import { hasOwnWindow, openOwnWindow } from "./window-host";

/** In the order they're preferred: Edge last, as it adds its own sign-in prompts and pop-ups. */
const CANDIDATES: Record<string, string[]> = {
  win32: [
    ...["Google\\Chrome\\Application\\chrome.exe", "BraveSoftware\\Brave-Browser\\Application\\brave.exe", "Chromium\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe"]
      .flatMap((exe) => [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].map((base) => `${base}\\${exe}`)),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/brave-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"],
};

/** The browser for an app window: TRIP_PLANNER_BROWSER (also used by tests, with TRIP_PLANNER_BROWSER_ARGS for extra
 *  flags), else the first Chromium browser found; null if there's none. */
export function appBrowser() {
  if (process.env.TRIP_PLANNER_BROWSER) return process.env.TRIP_PLANNER_BROWSER;
  return (CANDIDATES[process.platform] || []).find((p) => p && !p.startsWith("undefined") && fs.existsSync(p)) || null;
}
const extraArgs = () => (process.env.TRIP_PLANNER_BROWSER_ARGS || "").split(/\s+/).filter(Boolean);
/** Whether the app can open in a window of its own here. */
export const hasAppWindow = () => hasOwnWindow() || !!appBrowser();

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
  if (mode !== "app") return openInBrowser(url);
  const page = `${url}${url.includes("?") ? "&" : "?"}window=app`;
  // A browser asked for by name wins over the app's own window.
  if (!process.env.TRIP_PLANNER_BROWSER && openOwnWindow(page, dataDir, () => openBrowserWindow(url, dataDir))) return;
  openBrowserWindow(url, dataDir);
}

function openBrowserWindow(url: string, dataDir: string) {
  const browser = appBrowser();
  if (!browser) return openInBrowser(url);
  const [cmd, args] = [browser, [`--app=${url}${url.includes("?") ? "&" : "?"}window=app`, `--user-data-dir=${path.join(dataDir, "window")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1500,950", ...extraArgs()]] as const;
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/** Shows a folder in the system's file manager (Explorer, Finder…). */
export function openFolder(dir: string) {
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [dir], { stdio: "ignore", detached: true }).on("error", (e) => console.log(`Couldn't open ${dir}: ${e.message}`)).unref();
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
// so the browser would open the link in a tab but stay behind. A short hidden PowerShell step brings its window up:
// it joins the input of the window that has focus now (the planner's), which Windows allows, then hands focus to the
// browser's window (restoring it if minimized). The result goes to the log, to see why if it doesn't work somewhere.
const FRONT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Milliseconds 400
Add-Type -Namespace TP -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
'@
$p = Get-Process -Name $env:TP_BROWSER | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime | Select-Object -First 1
if (-not $p) { "no window for $env:TP_BROWSER"; exit }
$h = $p.MainWindowHandle
if ([TP.W]::IsIconic($h)) { [void][TP.W]::ShowWindow($h, 9) }
$fg = [TP.W]::GetForegroundWindow()
$me = [TP.W]::GetCurrentThreadId()
$fgThread = [TP.W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$target = [TP.W]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
$a = [TP.W]::AttachThreadInput($me, $fgThread, $true)
$b = [TP.W]::AttachThreadInput($target, $fgThread, $true)
[TP.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [TP.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][TP.W]::BringWindowToTop($h)
$ok = [TP.W]::SetForegroundWindow($h)
[void][TP.W]::AttachThreadInput($target, $fgThread, $false)
[void][TP.W]::AttachThreadInput($me, $fgThread, $false)
Start-Sleep -Milliseconds 200
"attached=$a/$b set=$ok front=$([TP.W]::GetForegroundWindow() -eq $h)"`;

export function bringToFront(processName: string) {
  if (process.platform !== "win32" || !/^[\w .-]+$/.test(processName)) return;
  const encoded = Buffer.from(FRONT_SCRIPT, "utf16le").toString("base64");
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { ...process.env, TP_BROWSER: processName } });
  let out = "";
  ps.stdout.on("data", (d) => { out += d; });
  ps.on("close", () => { if (!/front=True/.test(out)) console.log(`Couldn't bring ${processName} to the front: ${out.trim() || "no answer"}`); });
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
