// What kind of folder a path is, for sync folders: one a cloud app keeps in step (OneDrive, Dropbox, iCloud Drive,
// Google Drive for desktop), on a network drive, on a USB stick or other removable drive, or only on this computer.
// Only the first three reach anyone else: a plain folder here is just a second copy (Settings → Sync warns).
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type FolderKind = "onedrive" | "dropbox" | "icloud" | "gdrive" | "network" | "removable" | "local";
export const KIND_LABEL: Record<FolderKind, string> = {
  onedrive: "OneDrive", dropbox: "Dropbox", icloud: "iCloud Drive", gdrive: "Google Drive for desktop", network: "Network drive", removable: "USB or removable drive", local: "Only on this computer",
};

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
const inside = (p: string, dir: string | undefined) => !!dir && (norm(p) === norm(dir) || norm(p).startsWith(`${norm(dir)}${path.sep}`));

/** A cloud app's folder, by where it is. */
function cloudOf(p: string): FolderKind | null {
  const home = os.homedir();
  if ([process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].some((d) => inside(p, d))) return "onedrive";
  const rel = norm(p).startsWith(norm(home)) ? norm(p).slice(norm(home).length) : "";
  if (/^[\\/](onedrive|library[\\/]cloudstorage[\\/]onedrive)/.test(rel)) return "onedrive";
  if (/^[\\/](dropbox|library[\\/]cloudstorage[\\/]dropbox)/.test(rel)) return "dropbox";
  if (/^[\\/](library[\\/]mobile documents[\\/]com~apple~clouddocs|icloud ?drive)/.test(rel)) return "icloud";
  if (/^[\\/](google drive|library[\\/]cloudstorage[\\/]googledrive)/.test(rel)) return "gdrive";
  return null;
}

const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out)));
});

/** Windows: each drive letter's kind (Win32_LogicalDisk: 2 removable, 4 network), kept for a minute. */
let drives: { at: number; map: Map<string, { type: number; name: string }> } | null = null;
async function windowsDrive(letter: string) {
  if (!drives || Date.now() - drives.at > 60_000) {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_LogicalDisk | ForEach-Object { \"$($_.DeviceID)|$($_.DriveType)|$($_.VolumeName)\" }"]);
    const map = new Map<string, { type: number; name: string }>();
    for (const line of out.split(/\r?\n/)) { const [id, type, name] = line.trim().split("|"); if (id) map.set(id.toUpperCase(), { type: Number(type), name: name || "" }); }
    drives = { at: Date.now(), map };
  }
  return drives.map.get(letter.toUpperCase());
}

/** Mac and Linux: the file system the folder is on ("smbfs", "nfs", "cifs"…) and where it's mounted. */
async function mountOf(p: string): Promise<{ fs: string; at: string } | null> {
  const out = await run("df", ["-P", p]);
  const at = out.trim().split(/\r?\n/).at(-1)?.split(/\s+/).at(-1);
  if (!at) return null;
  const mounts = await run("mount", []);
  const line = mounts.split(/\r?\n/).find((l) => l.includes(` on ${at} `));
  const fsType = line?.match(/\(([^,)]+)/)?.[1] || line?.match(/ type (\S+)/)?.[1] || "";
  return { fs: fsType.toLowerCase(), at };
}

export async function folderKind(p: string): Promise<FolderKind> {
  const cloud = cloudOf(p);
  if (cloud) return cloud;
  const full = path.resolve(p);
  if (full.startsWith("\\\\")) return "network";
  if (process.platform === "win32") {
    const d = /^([a-z]:)/i.exec(full)?.[1];
    const info = d ? await windowsDrive(d) : undefined;
    if (info?.name && /google drive/i.test(info.name)) return "gdrive";
    return info?.type === 4 ? "network" : info?.type === 2 ? "removable" : "local";
  }
  const m = await mountOf(full);
  if (m && /smb|nfs|cifs|afp|webdav|sshfs|fuse\.sshfs/.test(m.fs)) return "network";
  if (m && /^\/(volumes|media|run\/media)\//i.test(`${m.at}/`) && m.at !== "/") return "removable";
  return "local";
}
