// Photos and videos from a folder on this computer for the map's Photos layer: the same list the Google Drive folders give
// (where and when each was taken, from the file's own EXIF or movie header), read straight from the disk. Subfolders are
// included. What's read from a file is kept (by its path, size and change date), so a folder of thousands is read once.
// A folder is written "local:<path>" in the trip, so it can sit in the same list as Drive folders.
import fs from "node:fs";
import path from "node:path";
import { errMsg } from "../config";
import { diskCache } from "../util/disk-cache";
import { deleteKind, moveToTrash } from "../util/trash";
import { type Res, sendJson } from "../util/http";
import { pool } from "../trip/overpass";
import { type Exif, readExif, turnFor } from "./exif";
import type { Photo, PhotoList } from "./photos";
import { readVideoHeader, timeFromName } from "./video-header";

const IMG = /\.(jpe?g|png|webp|gif)$/i, VID = /\.(mp4|m4v|mov|webm)$/i, HEIC = /\.(heic|heif)$/i;
const MAX_FILES = 3000, MAX_DEPTH = 6;
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  // A phone's .mov is usually the same H.264 video as an .mp4: browsers play it as one.
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm",
};
/** Whether this account may delete the file: it and the folder it's in can be written to. */
const mayDelete = async (file: string) => {
  try { await Promise.all([file, path.dirname(file)].map((f) => fs.promises.access(f, fs.constants.W_OK))); return true; } catch { return false; }
};
const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] || "application/octet-stream";

export const isLocal = (link: string) => /^local:/i.test(String(link || "").trim());
export const localRoot = (link: string) => path.resolve(String(link).trim().slice(6).trim());

interface Meta { t?: string; author?: string; lat?: number; lng?: number; rot?: number; dur?: number }
/** What was read from each file, by "path|size|changed": not read again while the file is as it was. */
const metas = diskCache<Meta>("local-photo-meta-v2.json");
/** The last list of each folder, so the file and thumbnail routes only serve what's in one. */
const lists = new Map<string, PhotoList>();

/** The first bytes of a file (enough for the EXIF block, or the atoms of a movie). */
async function readAt(file: string, start: number, len: number): Promise<Buffer | null> {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(len), { bytesRead } = await fh.read(buf, 0, len, start);
    return bytesRead ? buf.subarray(0, bytesRead) : null;
  } finally { await fh.close(); }
}

async function metaOf(file: string, size: number, mtime: number, video: boolean, jpeg: boolean): Promise<Meta> {
  const key = `${file}|${size}|${Math.round(mtime)}`;
  if (metas.data[key]) return metas.data[key];
  let m: Meta = {};
  try {
    if (video) {
      const h = await readVideoHeader((start, len) => readAt(file, start, len));
      m = { ...(h.t ? { t: h.t } : {}), ...(h.lat != null ? { lat: h.lat, lng: h.lng } : {}), ...(h.dur ? { dur: h.dur } : {}) };
    } else if (jpeg) {
      const buf = await readAt(file, 0, 192 * 1024), x: Exif = buf ? readExif(buf) : {}, rot = turnFor(x.orientation);
      m = { ...(x.t ? { t: x.t } : {}), ...(x.lat != null ? { lat: x.lat, lng: x.lng } : {}), ...(rot ? { rot } : {}), ...(x.author ? { author: x.author } : {}) };
    }
  } catch { /* unreadable: listed without its details */ }
  metas.data[key] = m; metas.save();
  return m;
}

/** Every media file under the folder (up to MAX_FILES), with its path relative to it, in a stable order. */
async function walk(root: string) {
  const out: { rel: string; abs: string }[] = [];
  let heic = 0, total = 0;
  const visit = async (dir: string, depth: number) => {
    let names: fs.Dirent[];
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const e of names) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < MAX_DEPTH) await visit(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (HEIC.test(e.name)) { heic++; total++; continue; }
      if (!IMG.test(e.name) && !VID.test(e.name)) continue;
      total++;
      if (out.length < MAX_FILES) out.push({ rel: path.relative(root, abs).split(path.sep).join("/"), abs });
    }
  };
  await visit(root, 0);
  return { files: out, heic, total };
}

/** The photos and videos in a folder on this computer. Throws with a reason the page can show. */
export async function listLocal(link: string): Promise<PhotoList> {
  const root = localRoot(link);
  let st: fs.Stats;
  try { st = await fs.promises.stat(root); } catch { throw new Error(`The folder ${root} isn't on this computer (or can't be opened). If it's on another drive or computer, it has to be connected.`); }
  if (!st.isDirectory()) throw new Error(`${root} isn't a folder.`);
  const { files, heic, total } = await walk(root);
  const enc = encodeURIComponent(link), kind = await deleteKind(root);
  const photos = (await pool(files, 8, async ({ rel, abs }): Promise<Photo | null> => {
    let s: fs.Stats;
    try { s = await fs.promises.stat(abs); } catch { return null; }
    const video = VID.test(rel), m = await metaOf(abs, s.size, s.mtimeMs, video, /\.jpe?g$/i.test(rel));
    const t = m.t || timeFromName(path.basename(rel)), dir = path.posix.dirname(rel), del = await mayDelete(abs);
    return {
      id: rel, name: path.basename(rel), t, size: s.size, ...(del ? { del: kind } : {}), ...(m.author ? { author: m.author } : {}), ...(!t ? { up: new Date(s.mtimeMs).toISOString().slice(0, 19) } : {}), ...(dir !== "." ? { dir } : {}),
      // The size comes last ("=s220"): the page swaps it for the one it needs, like a Google thumbnail's.
      thumb: `/api/photos/thumb?folder=${enc}&id=${encodeURIComponent(rel)}&px=s220`,
      ...(m.lat != null ? { lat: m.lat, lng: m.lng } : {}), ...(m.rot ? { rot: m.rot } : {}),
      ...(video ? { video: true as const, ...(m.dur ? { dur: m.dur } : {}) } : {}),
    };
  })).filter((p): p is Photo => !!p);
  photos.sort((a, b) => (a.t ? 0 : 1) - (b.t ? 0 : 1) || a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
  const list: PhotoList = { folder: link, name: path.basename(root) || root, at: Date.now(), photos, total, truncated: total - heic > photos.length, ...(heic ? { skipped: heic } : {}) };
  lists.set(link, list);
  return list;
}

/** The file for an id of a folder that was listed (never anything outside it), listing it first when this server hasn't yet. */
async function fileOf(link: string, id: string): Promise<{ abs: string; photo: Photo } | null> {
  const list = lists.get(link) || (await listLocal(link).catch(() => null));
  const photo = list?.photos.find((p) => p.id === id);
  if (!list || !photo) return null;
  const root = localRoot(link), abs = path.resolve(root, id);
  return abs.startsWith(root + path.sep) ? { abs, photo } : null;
}

/** Deletes a file of a listed folder: into the bin, or for good where there's none (only when `permanent` says that
 *  was agreed to). */
export async function localDelete(link: string, id: string, permanent: boolean): Promise<void> {
  const f = lists.has(link) ? await fileOf(link, id) : null;
  if (!f) throw new Error("That file isn't in the folder.");
  if (!(await mayDelete(f.abs))) throw new Error("You don't have permission to delete this file.");
  const kind = await deleteKind(localRoot(link));
  if (kind === "permanent" && !permanent) throw new Error("This drive has no Recycle Bin. Refresh the photos and try again.");
  try { await (kind === "trash" ? moveToTrash(f.abs) : fs.promises.unlink(f.abs)); }
  catch (e) { throw new Error(`Couldn't delete it: ${errMsg(e)}`); }
  const list = lists.get(link)!;
  lists.set(link, { ...list, photos: list.photos.filter((p) => p.id !== id), total: list.total - 1 });
}

/** The file itself, with the parts a browser asks for (how a video is played and sought in). */
export async function localFile(link: string, id: string, res: Res, range = ""): Promise<void> {
  const f = await fileOf(link, id);
  if (!f) return sendJson(res, 404, { error: "That file isn't in the folder." });
  const size = (await fs.promises.stat(f.abs)).size, m = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    // "bytes=500-" from 500; "bytes=-500" the last 500; "bytes=0-99" a piece.
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); }
    if (start >= size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    status = 206;
  }
  res.writeHead(status, {
    "Content-Type": mimeOf(f.abs), "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
    ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "Cache-Control": "private, max-age=3600",
  });
  const stream = fs.createReadStream(f.abs, { start, end });
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** A grey card with a play sign, for a video (a frame can't be taken from it here). */
export const VIDEO_CARD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" fill="#3a3f47"/><circle cx="80" cy="60" r="24" fill="#000" fill-opacity=".45" stroke="#fff" stroke-width="3"/><path d="M72 46 L96 60 L72 74 Z" fill="#fff"/></svg>`;

/**
 * A picture at a small size: the preview stored inside the JPEG (instant), else the file itself for the browser to
 * scale; a video gets a card. A big size (the viewer) is always the file.
 */
export async function localThumb(link: string, id: string, px: number, res: Res): Promise<void> {
  const f = await fileOf(link, id);
  if (!f) return sendJson(res, 404, { error: "That file isn't in the folder." });
  if (f.photo.video) { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" }); res.end(VIDEO_CARD); return; }
  if (px <= 400 && /\.jpe?g$/i.test(f.abs)) {
    try {
      const buf = await readAt(f.abs, 0, 192 * 1024), thumb = buf ? readExif(buf).thumb : undefined;
      if (thumb) { res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(thumb.length), "Cache-Control": "private, max-age=86400" }); res.end(thumb); return; }
    } catch (e) { console.error(`Reading a preview failed: ${errMsg(e)}`); }
  }
  return localFile(link, id, res);
}
