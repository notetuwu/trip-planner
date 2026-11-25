// A sync folder on this computer (or a network drive, or a folder OneDrive, Dropbox or iCloud keep in step here): the
// same few things the sync asks of Google Drive (google.ts), done with files. Ids are "local:" and the full path.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DriveFile } from "./google";

export const LOCAL = "local:";
export const isLocalId = (id: unknown): id is string => typeof id === "string" && id.startsWith(LOCAL) && id.length > LOCAL.length + 1;
const pathOf = (id: string) => path.resolve(id.slice(LOCAL.length));
const writable = (p: string) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
const md5 = (b: Buffer | string) => crypto.createHash("md5").update(b).digest("hex");
const MAX_TRIP_BYTES = 25 * 1024 * 1024;

export function folderInfo(id: string): { id: string; name: string; canWrite: boolean } {
  const p = pathOf(id);
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new Error("That folder isn't there (anymore). A network drive or USB stick may not be connected."); }
  if (!st.isDirectory()) throw new Error("That's a file, not a folder.");
  return { id: LOCAL + p, name: path.basename(p) || p, canWrite: writable(p) };
}

function meta(file: string): DriveFile {
  const st = fs.statSync(file);
  return { id: LOCAL + file, name: path.basename(file), md5Checksum: md5(fs.readFileSync(file)), modifiedTime: st.mtime.toISOString(), size: String(st.size), capabilities: { canEdit: writable(file) } };
}

/** The trip files in the folder (only there, not in folders inside it). */
export function listTripFiles(folder: string): DriveFile[] {
  const p = pathOf(folder);
  return fs.readdirSync(p).filter((f) => /\.json$/i.test(f)).map((f) => path.join(p, f))
    .filter((f) => { try { const st = fs.statSync(f); return st.isFile() && st.size <= MAX_TRIP_BYTES; } catch { return false; } })
    .map(meta);
}

export function fileMeta(id: string): DriveFile & { trashed?: boolean } {
  const f = pathOf(id);
  if (!fs.existsSync(f)) return { id, name: path.basename(f), md5Checksum: "", trashed: true };
  return meta(f);
}

export function download(id: string): string {
  const f = pathOf(id);
  if (fs.statSync(f).size > MAX_TRIP_BYTES) throw new Error("That trip file is too big.");
  return fs.readFileSync(f, "utf8");
}

/** Writes a trip file (a new one in `folder`, or over file `id`): to a temporary file first, then swapped in, so a
 *  sync app or someone opening it never sees half a file. */
export function upload(o: { id?: string; folder?: string; name: string; text: string }): DriveFile {
  let file: string;
  if (o.id) file = pathOf(o.id);
  else {
    const dir = pathOf(o.folder!), base = o.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/(\.trip)?\.json$/i, "") || "Trip";
    file = path.join(dir, `${base}.trip.json`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} ${n}.trip.json`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, o.text);
  fs.renameSync(tmp, file);
  return meta(file);
}
