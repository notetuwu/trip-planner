// Installs an update: downloads it (checked against GitHub's SHA-256), then runs the new installer silently (Windows) or
// swaps the program for the new one (Windows portable, Linux; on macOS the whole .app), and restarts. The open window
// reloads itself once the new version answers.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, errMsg } from "../config";
import { extractFromTarGz } from "../util/tar";
import { extractFromZip } from "../util/zip";
import { backUpData } from "./backup";
import { type UpdateInfo, checkForUpdate, findOlderRelease, macBundle } from "./check";

export interface UpdateStatus { phase: "idle" | "downloading" | "installing" | "error"; received: number; total: number; error?: string }
export const status: UpdateStatus = { phase: "idle", received: 0, total: 0 };

/** Set by main.ts: stops the server so the new version can take over the port. */
let shutdown: () => Promise<void> = async () => {};
export const onShutdown = (fn: () => Promise<void>) => { shutdown = fn; };

async function download(asset: NonNullable<UpdateInfo["asset"]>): Promise<Buffer> {
  status.phase = "downloading"; status.received = 0; status.total = asset.size;
  const res = await fetch(asset.url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60e3) });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  if (!status.total) status.total = Number(res.headers.get("content-length")) || 0; // unknown when found without the API
  const parts: Buffer[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { parts.push(Buffer.from(chunk)); status.received += chunk.length; }
  const data = Buffer.concat(parts);
  if (asset.sha256 && crypto.createHash("sha256").update(data).digest("hex") !== asset.sha256) throw new Error("The download is damaged (checksum mismatch).");
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renames, retrying for a while: a virus scanner often holds a freshly written exe for a few seconds (EBUSY/EPERM). */
async function renameRetrying(from: string, to: string, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { fs.renameSync(from, to); return; }
    catch (e: any) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(e?.code) || Date.now() - t0 > ms) throw e;
      await sleep(500);
    }
  }
}

/** Starts a program on its own, so it keeps running when this one exits; fails when it can't be started at all. */
function launch(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Stops the server so the new version can take the port, but never waits long: a connection that won't close must not
 *  keep the update from going ahead (that left the window at "restarting" for good). */
const stopServer = () => Promise.race([shutdown().catch(() => {}), sleep(3000)]);

/** `beforeInstall` runs once the download is there and checked; if it fails, nothing is installed. */
async function install(info: UpdateInfo, beforeInstall?: () => void) {
  const data = await download(info.asset!);
  beforeInstall?.();
  status.phase = "installing";
  if (info.mode === "installer") {
    const setup = path.join(os.tmpdir(), info.asset!.name);
    fs.writeFileSync(setup, data);
    // The installer is started first (it ends this app if it's still running, then starts the new version without a new window),
    // so nothing after can keep it from running. Its log goes next to the app's own.
    const log = path.join(ROOT, "update-install.log");
    console.log(`Update: starting the installer for ${info.latest} (its log: ${log}).`);
    await launch(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS", `/LOG=${log}`]);
    await stopServer();
  } else if (info.mode === "mac") {
    await swapMacApp(data);
  } else if (info.mode === "linux") {
    const exe = extractFromTarGz(data, (name) => name === "trip-planner/trip-planner");
    if (!exe) throw new Error("The update doesn't contain the trip-planner program.");
    const current = process.execPath, dir = path.dirname(current), fresh = path.join(dir, "trip-planner.new"), old = path.join(dir, "trip-planner.old");
    fs.writeFileSync(fresh, exe, { mode: 0o755 });
    fs.rmSync(old, { force: true });
    fs.renameSync(current, old); // a running program can be renamed
    try { fs.renameSync(fresh, current); }
    catch (e) { try { fs.renameSync(old, current); } catch { /* sorted out on the next start */ } throw new Error(`Couldn't replace the program (${errMsg(e)}).`); }
    await stopServer();
    await launch(current, ["--no-window"]);
  } else {
    const exe = extractFromZip(data, (name) => name.endsWith("/Trip Planner.exe") || name === "Trip Planner.exe");
    if (!exe) throw new Error("The update doesn't contain Trip Planner.exe.");
    const current = process.execPath, dir = path.dirname(current), old = path.join(dir, "Trip Planner.old.exe");
    const fresh = path.join(dir, "Trip Planner.new.exe");
    fs.writeFileSync(fresh, exe);
    fs.rmSync(old, { force: true });
    await renameRetrying(current, old); // a running exe can be renamed (not overwritten) on Windows
    try { await renameRetrying(fresh, current); }
    catch (e) {
      // Put this version back under its name, so the shortcut still works, and say what happened.
      try { fs.renameSync(old, current); fs.rmSync(fresh, { force: true }); } catch { /* left for the next start to sort out */ }
      throw new Error(`Couldn't replace Trip Planner.exe (${errMsg(e)}); a virus scanner may be holding the new file. Try again in a minute.`);
    }
    await stopServer();
    await launch(current, ["--no-window"]);
  }
  console.log("Update: closing for the new version.");
  // With the installer, at once: it looks for the running app a moment after it starts, and finding it half closed
  // makes it give up (installers up to 3.37.0, still run by a roll back, don't wait for it).
  setTimeout(() => process.exit(0), info.mode === "installer" ? 0 : 300);
}

/** macOS: the new .app unpacked next to the running one (same disk, so it can be moved in), the running one moved
 *  aside, the new one put in its place and started. The old one goes on the next start. */
async function swapMacApp(zip: Buffer) {
  const app = macBundle();
  if (!app) throw new Error("This copy isn't a macOS app.");
  const dir = path.dirname(app), work = path.join(dir, ".Trip Planner update");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work);
  try {
    const file = path.join(work, "update.zip");
    fs.writeFileSync(file, zip);
    execFileSync("ditto", ["-x", "-k", file, work]); // keeps the bundle's links, rights and signature
    const fresh = path.join(work, "Trip Planner.app");
    if (!fs.existsSync(path.join(fresh, "Contents", "MacOS", "trip-planner"))) throw new Error("The update doesn't contain Trip Planner.app.");
    // Downloaded by the app itself it isn't marked as from the internet; in case it is, so macOS doesn't stop it.
    try { execFileSync("xattr", ["-dr", "com.apple.quarantine", fresh]); } catch { /* not marked */ }
    const old = path.join(dir, "Trip Planner.old.app");
    fs.rmSync(old, { recursive: true, force: true });
    fs.renameSync(app, old);
    try { fs.renameSync(fresh, app); }
    catch (e) { try { fs.renameSync(old, app); } catch { /* sorted out on the next start */ } throw new Error(`Couldn't replace Trip Planner.app (${errMsg(e)}).`); }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  await stopServer();
  await launch(path.join(app, "Contents", "MacOS", "trip-planner"), ["--no-window"]);
}

/** Starts the update in the background; the page follows along through `status`. */
export async function startUpdate(): Promise<UpdateStatus> {
  if (status.phase === "downloading" || status.phase === "installing") return status;
  const info = await checkForUpdate();
  if (!info?.newer || !info.asset || info.mode === "manual") throw new Error("No update this copy can install by itself.");
  install(info).catch(failed);
  return status;
}

const failed = (e: unknown) => { status.phase = "error"; status.error = errMsg(e); console.error("Update failed:", errMsg(e)); };

/** The same for an older version (Settings → Updates → Roll back), with a copy of the trips and settings kept first: the
 *  older version may not know everything that's in them. */
export async function startRollback(version: string): Promise<UpdateStatus> {
  if (status.phase === "downloading" || status.phase === "installing") return status;
  const before = { ...status };
  Object.assign(status, { phase: "downloading", received: 0, total: 0, error: undefined }); // taken, while GitHub is asked
  let info: UpdateInfo;
  try { info = await findOlderRelease(version); } catch (e) { Object.assign(status, before); throw e; }
  install(info, () => console.log(`Rolling back to ${version}: your data was copied to ${backUpData(ROOT, `before-${version}`)}.`)).catch(failed);
  return status;
}

/** Removes what the previous portable update left behind (retrying while the old version is still exiting). An
 *  update cut short could leave this copy as "Trip Planner.new.exe" or ".old.exe" with no "Trip Planner.exe": then it
 *  takes that name again, so shortcuts and the next update work. */
export function cleanUpAfterUpdate(tries = 5) {
  // macOS and Linux: the copy the last update moved aside.
  if (process.platform !== "win32") {
    const app = macBundle(), aside = app ? path.join(path.dirname(app), "Trip Planner.old.app") : path.join(path.dirname(process.execPath), "trip-planner.old");
    if (process.platform === "darwin" && !app) return;
    try { fs.rmSync(aside, { recursive: true, force: true }); } catch { if (tries > 1) setTimeout(() => cleanUpAfterUpdate(tries - 1), 3000).unref(); }
    return;
  }
  const dir = path.dirname(process.execPath), main = path.join(dir, "Trip Planner.exe");
  if (process.platform === "win32" && /^Trip Planner\.(new|old)\.exe$/i.test(path.basename(process.execPath)) && !fs.existsSync(main)) {
    try { fs.renameSync(process.execPath, main); } catch { /* keep running under this name */ }
  }
  // A download that never got swapped in.
  if (path.basename(process.execPath).toLowerCase() === "trip planner.exe") { try { fs.rmSync(path.join(dir, "Trip Planner.new.exe"), { force: true }); } catch { /* still held */ } }
  const old = path.join(dir, "Trip Planner.old.exe");
  if (!fs.existsSync(old)) return;
  try { fs.rmSync(old, { force: true }); } catch { if (tries > 1) setTimeout(() => cleanUpAfterUpdate(tries - 1), 3000).unref(); }
}
