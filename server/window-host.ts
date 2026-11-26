// The Windows app's own window: a small program showing the page in WebView2, the web engine that comes with Windows,
// without a browser around it (so no browser's sign-in prompts, assistants or text pop-ups). Its source is
// packaging/window/TripWindow.cs; the packaged app carries it inside and unpacks it into the data folder to run it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAsset } from "node:sea";
import { PACKAGED, VERSION, errMsg } from "./config";

/** The files baked into the app as "window/<name>" (scripts/window-host.mjs builds them). */
const FILES = ["Trip Planner Window.exe", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "WebView2-LICENSE.txt"];

/** Whether the WebView2 runtime is installed (part of Windows 11, and of an up-to-date Windows 10). */
export function webViewInstalled(env: NodeJS.ProcessEnv = process.env) {
  return [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].some((base) => {
    if (!base) return false;
    const dir = path.join(base, "Microsoft", "EdgeWebView", "Application");
    try { return fs.readdirSync(dir).some((v) => fs.existsSync(path.join(dir, v, "msedgewebview2.exe"))); } catch { return false; }
  });
}

/** Whether this copy of the app can open its own WebView2 window. */
export const hasOwnWindow = () => process.platform === "win32" && PACKAGED && webViewInstalled();

/** Unpacks the window program into "<data>/window-host/<version>" (once per version; older ones are removed). */
function unpack(dataDir: string) {
  const base = path.join(dataDir, "window-host"), dir = path.join(base, VERSION);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of FILES) {
    const data = Buffer.from(getAsset(`window/${name}`)), file = path.join(dir, name);
    // Only when missing or different: an open window holds its files.
    let same = false;
    try { same = fs.readFileSync(file).equals(data); } catch { /* not there yet */ }
    if (!same) fs.writeFileSync(file, data);
  }
  for (const old of fs.readdirSync(base)) {
    if (old !== VERSION) try { fs.rmSync(path.join(base, old), { recursive: true, force: true }); } catch { /* still open */ }
  }
  return path.join(dir, FILES[0]);
}

/** Opens the page in the app's own window. False when it can't here; `failed` is told if the window then doesn't come up
 *  (so a browser window can be opened instead). */
export function openOwnWindow(url: string, dataDir: string, failed: () => void) {
  if (!hasOwnWindow()) return false;
  try {
    const started = Date.now();
    const child = spawn(unpack(dataDir), [url, path.join(dataDir, "webview")], { stdio: "ignore", detached: true });
    let told = false;
    const giveUp = (why: string) => { if (!told) { told = true; console.log(`The app's window didn't open (${why}); opening a browser window instead.`); failed(); } };
    child.on("error", (e) => giveUp(e.message));
    child.on("exit", (code) => { if (code && Date.now() - started < 20_000) giveUp(`exit code ${code}`); });
    child.unref();
    return true;
  } catch (e) {
    console.log(`The app's window couldn't be started: ${errMsg(e)}`);
    return false;
  }
}
