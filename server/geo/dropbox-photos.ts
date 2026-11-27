// Photos and videos from a Dropbox folder ("dropbox:<id>" in the trip) for the map's Photos layer, read with the Dropbox
// sign-in of Settings → Accounts. Only to look at: nothing in Dropbox is changed or deleted. Dropbox's folder listing
// doesn't say where or when a picture was taken, so that's read from the start of each file (a JPEG's EXIF block, a
// video's header), one file at a time per worker in the background, and kept: each file is read once. Thumbnails and
// originals come through the planner. Subfolders are included, two levels down, like Drive folders.
import { Readable } from "node:stream";
import { errMsg } from "../config";
import * as box from "../sync/dropbox";
import { diskCache } from "../util/disk-cache";
import { type Res, sendJson } from "../util/http";
import { readExif } from "./exif";
import { VIDEO_CARD } from "./local-photos";
import type { Photo, PhotoList } from "./photos";
import { readVideoHeader, timeFromName } from "./video-header";

export const isDropboxFolder = (link: string) => box.isDropboxId(String(link || "").trim());

/** A folder as the folder browser or a pasted shared link gives it, as its own id. A folder shared with you that isn't in
 *  your Dropbox yet is added to it. */
export async function dropboxPhotoFolder(link: string): Promise<string> {
  if (!box.ready()) throw new Error(NO_ACCESS);
  const id = /^https?:/i.test(link) ? await box.folderFromLink(link) : await box.resolveFolder(link);
  if (!box.isDropboxId(id)) throw new Error("Not a Dropbox folder.");
  return id;
}

const IMG = /\.(jpe?g|png|webp|gif)$/i, JPEG = /\.jpe?g$/i, VID = /\.(mp4|m4v|mov|webm)$/i, HEIC = /\.(heic|heif)$/i;
const MAX_AGE = 60 * 60_000, MAX_PHOTOS = 3000, MAX_DEPTH = 2;
/** Enough of a JPEG for its EXIF block. */
const EXIF_BYTES = 128 * 1024;
const WORKERS = 4, RETRY_AFTER = 10 * 60_000;
const NO_ACCESS = "Connect Dropbox in Settings → Accounts to show photos from Dropbox.";

interface Meta { t?: string; author?: string; lat?: number; lng?: number; dur?: number }
const cache = diskCache<PhotoList>("dropbox-photos.json");
/** What was read from each file, by its id and content: not read again while the file is as it was. */
const metas = diskCache<Meta>("dropbox-photo-meta.json");
/** Each listed file's key in `metas`, by its id. */
const keys = diskCache<string>("dropbox-photo-keys.json");

async function list(folder: string, dir: string, depth: number, out: Photo[], stats: { total: number; heic: number }) {
  const folders: { id: string; name: string }[] = [];
  for (const e of await box.folderEntries(folder)) {
    if (e.folder) { folders.push(e); continue; }
    if (HEIC.test(e.name)) { stats.heic++; stats.total++; continue; }
    const video = VID.test(e.name);
    if (!video && !IMG.test(e.name)) continue;
    stats.total++;
    if (out.length >= MAX_PHOTOS) continue;
    const t = timeFromName(e.name);
    keys.data[e.id] = `${e.id}|${e.version}`;
    out.push({
      id: e.id, name: e.name, t, ...(!t && e.modified ? { up: e.modified.slice(0, 19) } : {}), ...(dir ? { dir } : {}), ...(e.size ? { size: e.size } : {}),
      thumb: "", ...(video ? { video: true as const } : {}),
    });
  }
  if (depth < MAX_DEPTH) for (const f of folders) await list(f.id, dir ? `${dir}/${f.name}` : f.name, depth + 1, out, stats);
}

/** What the file itself says: where and when it was taken. */
async function readMeta(p: Photo): Promise<Meta> {
  if (p.video) {
    const h = await readVideoHeader((start, len) => box.readRange(p.id, start, len));
    return { ...(h.t ? { t: h.t } : {}), ...(h.lat != null ? { lat: h.lat, lng: h.lng } : {}), ...(h.dur ? { dur: h.dur } : {}) };
  }
  const buf = await box.readRange(p.id, 0, EXIF_BYTES), x = buf ? readExif(buf) : {};
  return { ...(x.t ? { t: x.t } : {}), ...(x.lat != null ? { lat: x.lat, lng: x.lng } : {}), ...(x.author ? { author: x.author } : {}) };
}

/** Whether there's something to read in it (other pictures carry no position or time that's read here). */
const readable = (p: Photo) => !!p.video || JPEG.test(p.name);
const queue: Photo[] = [];
const queued = new Set<string>(), failedAt = new Map<string, number>();
let workers = 0;

async function work() {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const key = keys.data[p.id];
    try { metas.data[key] = await readMeta(p); metas.save(); queued.delete(p.id); }
    catch (e) {
      // Asked too often: that file again after a pause.
      const wait = (e as { retryAfter?: number }).retryAfter;
      if (wait) { queue.push(p); await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
      queued.delete(p.id); failedAt.set(p.id, Date.now());
      console.error(`Reading a Dropbox file's details failed: ${errMsg(e)}`);
    }
  }
}

/** The list with what the files themselves said filled in, and how many are still to be read (in the background). */
function withMeta(link: string, l: PhotoList): PhotoList {
  let pending = 0;
  const enc = encodeURIComponent(link);
  const photos = l.photos.map((p): Photo => {
    const m = metas.data[keys.data[p.id]];
    if (!m && readable(p) && Date.now() - (failedAt.get(p.id) || 0) > RETRY_AFTER) {
      pending++;
      if (!queued.has(p.id)) { queued.add(p.id); queue.push(p); }
    }
    // The thumbnail's size comes last ("=s220"): the page swaps it for the one it needs, like a Google thumbnail's.
    const out: Photo = { ...p, ...m, t: m?.t || p.t, thumb: `/api/photos/thumb?folder=${enc}&id=${encodeURIComponent(p.id)}&px=s220` };
    if (out.t) delete out.up;
    return out;
  });
  while (queue.length && workers < WORKERS) { workers++; work().finally(() => { workers--; }); }
  photos.sort((a, b) => (a.t ? 0 : 1) - (b.t ? 0 : 1) || a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
  return { ...l, photos, ...(pending ? { pending } : {}) };
}

/** The photos and videos in a Dropbox folder. Throws with a reason the page can show. */
export async function listDropbox(link: string, refresh = false): Promise<PhotoList> {
  if (!box.ready()) throw new Error(NO_ACCESS);
  const hit = cache.data[link];
  if (hit && !refresh && Date.now() - hit.at < MAX_AGE) return withMeta(link, hit);
  const photos: Photo[] = [], stats = { total: 0, heic: 0 };
  let name = "";
  try {
    ({ name } = await box.folderInfo(link));
    await list(link, "", 0, photos, stats);
  } catch (e) { if (hit) return withMeta(link, hit); throw new Error(errMsg(e)); }
  const out: PhotoList = { folder: link, name, at: Date.now(), photos, total: stats.total, truncated: stats.total - stats.heic > photos.length, ...(stats.heic ? { skipped: stats.heic } : {}) };
  cache.data[link] = out; cache.save(); keys.save();
  return withMeta(link, out);
}

/** A photo of a folder that was listed before: nothing else in the Dropbox is handed out. */
const listed = (link: string, id: string) => cache.data[link]?.photos.find((p) => p.id === id);

function pipe(r: Response, res: Res, headers: Record<string, string>) {
  res.writeHead(r.status === 206 ? 206 : 200, { ...headers, "Cache-Control": "private, max-age=86400" });
  Readable.fromWeb(r.body as any).on("error", () => res.destroy()).pipe(res);
}

/** The file itself, with the parts a browser asks for (how a video is played and sought in). */
export async function dropboxFile(link: string, id: string, res: Res, range = ""): Promise<void> {
  const p = listed(link, id);
  if (!p) return sendJson(res, 404, { error: "That photo isn't in the folder." });
  if (!box.ready()) return sendJson(res, 400, { error: NO_ACCESS });
  const stop = new AbortController();
  res.on("close", () => stop.abort());
  const r = await box.fileResponse(id, /^bytes=\d*-\d*$/.test(range) ? range : "", stop.signal);
  const h = (n: string) => r.headers.get(n);
  const ext = /\.([a-z0-9]+)$/i.exec(p.name)?.[1]?.toLowerCase() || "";
  // (Dropbox sends every file as plain bytes: the type comes from the name. A phone's .mov plays as an .mp4.)
  const type = p.video ? (ext === "webm" ? "video/webm" : "video/mp4") : `image/${ext === "jpg" ? "jpeg" : ext}`;
  pipe(r, res, { "Content-Type": type, "Accept-Ranges": "bytes", ...(h("content-length") ? { "Content-Length": h("content-length")! } : {}), ...(h("content-range") ? { "Content-Range": h("content-range")! } : {}) });
}

/** A picture at a small size, made by Dropbox; a video gets a card. One Dropbox makes none of (over 20 MB) is the file. */
export async function dropboxThumb(link: string, id: string, px: number, res: Res): Promise<void> {
  const p = listed(link, id);
  if (!p) return sendJson(res, 404, { error: "That photo isn't in the folder." });
  if (p.video) { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" }); res.end(VIDEO_CARD); return; }
  if (!box.ready()) return sendJson(res, 400, { error: NO_ACCESS });
  const size = px <= 256 ? "w256h256" : px <= 640 ? "w640h480" : px <= 1024 ? "w1024h768" : "w2048h1536";
  const r = await box.thumbnail(id, size);
  if (!r) return dropboxFile(link, id, res);
  pipe(r, res, { "Content-Type": "image/jpeg" });
}
