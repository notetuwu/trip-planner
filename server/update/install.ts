// Installs an update on Windows: downloads it (checked against GitHub's SHA-256), then either runs the new installer
// silently or swaps the portable exe, and restarts. The open window reloads itself once the new version answers.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errMsg } from "../config";
import { extractFromZip } from "../util/zip";
import { type UpdateInfo, checkForUpdate } from "./check";

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

/** Starts a program on its own, so it keeps running when this one exits. */
const launch = (file: string, args: string[]) => spawn(file, args, { detached: true, stdio: "ignore" }).unref();

async function install(info: UpdateInfo) {
  const data = await download(info.asset!);
  status.phase = "installing";
  if (info.mode === "installer") {
    const setup = path.join(os.tmpdir(), info.asset!.name);
    fs.writeFileSync(setup, data);
    await shutdown();
    // The installer closes this app if it's still running, and starts the new version (without a new window) when done.
    launch(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS"]);
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
    await shutdown();
    launch(current, ["--no-window"]);
  }
  setTimeout(() => process.exit(0), 300);
}

/** Starts the update in the background; the page follows along through `status`. */
export async function startUpdate(): Promise<UpdateStatus> {
  if (status.phase === "downloading" || status.phase === "installing") return status;
  const info = await checkForUpdate();
  if (!info?.newer || !info.asset || info.mode === "manual") throw new Error("No update this copy can install by itself.");
  install(info).catch((e) => { status.phase = "error"; status.error = errMsg(e); console.error("Update failed:", errMsg(e)); });
  return status;
}

/** Removes what the previous portable update left behind (retrying while the old version is still exiting). An
 *  update cut short could leave this copy as "Trip Planner.new.exe" or ".old.exe" with no "Trip Planner.exe": then it
 *  takes that name again, so shortcuts and the next update work. */
export function cleanUpAfterUpdate(tries = 5) {
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
