// Folders on this computer for the app's folder browser (web/src/core/folder-picker.ts): the usual places (home,
// Desktop, Pictures… and folders that OneDrive, Dropbox or iCloud keep in step on this computer), the drives (with network
// drives mapped to a letter, or mounted), and what's in a folder. Only for the computer itself: a phone on the home
// network can't reach it (lan.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FsEntry { id: string; name: string; folder: boolean; canWrite: boolean; modified?: string; size?: number; kind?: "image" | "video" | "trip" | "file"; place?: string }

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i, VIDEO = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const kindOf = (name: string): FsEntry["kind"] => (IMAGE.test(name) ? "image" : VIDEO.test(name) ? "video" : /\.json$/i.test(name) ? "trip" : "file");
const writable = (p: string) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The starting points: the usual folders, the cloud folders kept on this computer, and the drives. */
export function fsPlaces(): FsEntry[] {
  const home = os.homedir(), out: FsEntry[] = [];
  const add = (p: string | undefined, name: string, place: string) => {
    if (p && isDir(p) && !out.some((x) => x.id.toLowerCase() === path.resolve(p).toLowerCase())) out.push({ id: path.resolve(p), name, folder: true, canWrite: writable(p), place });
  };
  add(home, "Home", "home");
  for (const [dir, name] of [["Desktop", "Desktop"], ["Documents", "Documents"], ["Pictures", "Pictures"], ["Downloads", "Downloads"]] as const) add(path.join(home, dir), name, dir.toLowerCase());
  // Cloud folders their apps keep in step here: sync works through them like through any folder.
  add(process.env.OneDrive || process.env.OneDriveConsumer, "OneDrive", "cloud");
  add(process.env.OneDriveCommercial, "OneDrive (work)", "cloud");
  add(path.join(home, "Dropbox"), "Dropbox", "cloud");
  add(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), "iCloud Drive", "cloud");
  add(path.join(home, "Google Drive"), "Google Drive (app)", "cloud");
  if (process.platform === "win32") {
    for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; if (fs.existsSync(d)) out.push({ id: d, name: `${String.fromCharCode(c)}:`, folder: true, canWrite: writable(d), place: "drive" }); }
  } else if (process.platform === "darwin") {
    try { for (const v of fs.readdirSync("/Volumes")) add(path.join("/Volumes", v), v, "drive"); } catch { /* none */ }
  } else {
    add("/", "Computer", "drive");
    try { for (const v of fs.readdirSync(`/media/${os.userInfo().username}`)) add(path.join(`/media/${os.userInfo().username}`, v), v, "drive"); } catch { /* none */ }
  }
  return out;
}

/** What's in a folder: its folders first, then its files (hidden ones left out; at most a few hundred). */
export function fsList(dir: string): { entries: FsEntry[]; more: boolean; path: string; parent: string | null } {
  const p = path.resolve(String(dir || ""));
  if (!isDir(p)) throw new Error("That folder doesn't exist (anymore), or it can't be opened.");
  let names: fs.Dirent[];
  try { names = fs.readdirSync(p, { withFileTypes: true }); }
  catch (e: any) { throw new Error(e?.code === "EPERM" || e?.code === "EACCES" ? "This folder can't be opened (no permission)." : `Can't open this folder: ${e?.message || e}`); }
  const entries: FsEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith(".") || d.name.startsWith("$") || /^(desktop\.ini|thumbs\.db|ntuser\..*)$/i.test(d.name)) continue;
    const full = path.join(p, d.name);
    let st: fs.Stats | null = null;
    try { st = fs.statSync(full); } catch { continue; } // a broken link, or no access
    const folder = st.isDirectory();
    entries.push({ id: full, name: d.name, folder, canWrite: folder ? writable(full) : false, modified: st.mtime.toISOString(), ...(folder ? {} : { size: st.size, kind: kindOf(d.name) }) });
  }
  entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parent = path.dirname(p);
  return { entries: entries.slice(0, 600), more: entries.length > 600, path: p, parent: parent === p ? null : parent };
}

/** A new folder in `parent`. */
export function fsMkdir(parent: string, name: string): FsEntry {
  const clean = String(name || "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 120);
  if (!clean || clean === "." || clean === "..") throw new Error("Give the folder a name.");
  const p = path.join(path.resolve(parent), clean);
  if (fs.existsSync(p)) throw new Error("There's already something with that name here.");
  fs.mkdirSync(p);
  return { id: p, name: clean, folder: true, canWrite: true };
}

/** What a pasted path is: a folder (its full path and name) or why not. */
export function fsCheck(raw: string): { path: string; name: string; canWrite: boolean } {
  const s = String(raw || "").trim().replace(/^["']+|["']+$/g, "").replace(/^file:\/\/\/?/i, "");
  const p = path.resolve(s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : decodeURI(s));
  if (!isDir(p)) throw new Error(fs.existsSync(p) ? "That's a file, not a folder." : "There's no folder at that path on this computer.");
  return { path: p, name: path.basename(p) || p, canWrite: writable(p) };
}
