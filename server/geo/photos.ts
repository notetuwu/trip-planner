// Photos for the map's Photos layer, from a shared Google Drive folder ("anyone with the link"): the Drive API lists its
// images and videos, with where and when each photo was taken (the EXIF position Drive keeps from the original file; a
// video's own header says it, read here). Read with the Google sign-in of Settings → Sync when there is one (then any
// folder the account can open works, shared or not), else with a Google API key with the Drive API on (Settings → API
// keys; the folder shared as "anyone with the link"). The list is kept on disk for an hour, so panning and reloading don't
// ask Google again; the thumbnails come straight from Google's servers to the browser.
import { Readable } from "node:stream";
import { USER_AGENT, errMsg } from "../config";
import { readSettings } from "../settings";
import { diskCache } from "../util/disk-cache";
import { type Res, sendJson } from "../util/http";
import { isLocal, listLocal, localFile } from "./local-photos";
import { bearer } from "../sync/google";
import { readVideoHeader, timeFromName } from "./video-header";

export interface Photo {
  id: string;
  name: string;
  /** Where it was taken (from the photo's GPS), when it has that. */
  lat?: number;
  lng?: number;
  /** When it was taken ("2027-09-10T09:41:03", the camera's clock); "" when the file has no time (a screenshot, or a photo
   *  sent through a messenger): the upload date says nothing about the trip, so it isn't used. */
  t: string;
  /** When it was uploaded to Drive, for photos with no camera time. */
  up?: string;
  /** The folder it's in, when that's a folder inside the shared one. */
  dir?: string;
  /** A thumbnail's address with its size at the end ("=s220"): the browser swaps the size for the one it needs. */
  thumb: string;
  w?: number;
  h?: number;
  /** A video (its length in seconds): played from the original file, with a frame from it as the picture. */
  video?: true;
  dur?: number;
  /** A picture from this computer: how far to turn its small preview (which is stored unrotated) to see it upright. */
  rot?: number;
}
export interface PhotoList {
  folder: string; /** The folder's own name in Drive. */ name: string; at: number; photos: Photo[]; total: number; truncated: boolean;
  /** Videos whose header hasn't been read yet (their place and time come in a little later: ask again). */
  pending?: number;
  /** Files in the folder that can't be shown (iPhone HEIC pictures, which browsers can't display). */
  skipped?: number;
  /** Read as the signed-in account (its thumbnails come through the planner). */
  auth?: boolean;
}

const cache = diskCache<PhotoList>("photos-v2.json");
const MAX_AGE = 60 * 60_000, MAX_PHOTOS = 3000, MAX_DEPTH = 2;
const FOLDER = "application/vnd.google-apps.folder";

/** The folder's id from what they pasted: a share link ("…/folders/ID?usp=sharing", "…/open?id=ID"), or the id itself. */
export function folderId(link: string): string {
  const s = String(link || "").trim();
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/);
  return m ? m[1] : "";
}

const googleKey = () => readSettings().googleKey || process.env.GOOGLE_API_KEY || "";

/** How to ask Drive: as the signed-in account (Settings → Sync), else with the API key; "" when neither is set up. */
type Access = { token: string } | { key: string } | "";
async function access(): Promise<Access> {
  const token = await bearer();
  if (token) return { token };
  const key = googleKey();
  return key ? { key } : "";
}
/** A Drive address and the request's headers, for that access. */
function asked(url: string, a: Access, headers: Record<string, string> = {}): [string, RequestInit] {
  const h = { "User-Agent": USER_AGENT, ...headers, ...(a && "token" in a ? { Authorization: `Bearer ${a.token}` } : {}) };
  return [a && "key" in a ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(a.key)}` : url, { headers: h }];
}
const NO_ACCESS = "Sign in with Google in Settings → Sync (or add a Google API key with the Drive API on in Settings → API keys) to show photos from Drive.";
/** Thumbnails of photos read as the signed-in account: Google only hands them out to that account, so they come through
 *  here (by file id). */
const thumbLinks = diskCache<string>("photo-thumbs.json");

/** What Google said, in words that say what to do (the common causes first). */
function explain(status: number, body: any): string {
  const e = body?.error, reason = e?.errors?.[0]?.reason || "", msg = String(e?.message || "");
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + msg) || /has not been used|is disabled/i.test(msg))
    return "The Drive API isn't switched on for this key: in the Google Cloud Console, open APIs & Services → Library, find \"Google Drive API\" and press Enable.";
  if (status === 400 && /API key/i.test(msg)) return "Google doesn't accept this API key. Check it in Settings → Planning.";
  if (status === 403 && /referer|restrict/i.test(msg + reason)) return "This API key is restricted (to websites or other APIs). Allow the Drive API for it, with no website restriction.";
  if (status === 403 && /rateLimit|quota/i.test(reason + msg)) return "Google's limit for this key is used up for now. Try again later.";
  if (status === 404 || status === 403) return "Google can't open that folder. Share it as \"Anyone with the link\" (Viewer) and check the link.";
  return `Google answered ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
}

async function list(dir: string, a: Access, name: string, depth: number, out: Photo[], stats: { total: number }, root = dir) {
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      q: `'${dir}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = '${FOLDER}')`,
      fields: "nextPageToken,files(id,name,mimeType,thumbnailLink,createdTime,imageMediaMetadata(location,time,width,height,rotation),videoMediaMetadata(width,height,durationMillis))",
      pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const [url, init] = asked(`https://www.googleapis.com/drive/v3/files?${q}`, a);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(explain(res.status, json));
    const folders: { id: string; name: string }[] = [];
    for (const f of json.files || []) {
      if (f.mimeType === FOLDER) { folders.push({ id: f.id, name: f.name }); continue; }
      stats.total++;
      if (out.length >= MAX_PHOTOS) continue;
      const meta = f.imageMediaMetadata || {}, loc = meta.location;
      // The camera's time is "2027:09:10 09:41:03" (no zone): kept as the camera wrote it, which is the local time there.
      const isVideo = String(f.mimeType).startsWith("video/"), vm = f.videoMediaMetadata || {};
      // A photo with no time of its own (a messenger strips it) often has it in its file name ("IMG_20270910_094103.jpg").
      const t = (typeof meta.time === "string" && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}/.test(meta.time) ? meta.time.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T") : "") || timeFromName(String(f.name));
      const rot = Number(meta.rotation) || 0;
      // Read as the account: the thumbnail comes through the planner (see thumbLinks).
      let thumb = String(f.thumbnailLink || "");
      if (thumb && a && "token" in a) { thumbLinks.data[f.id] = thumb; thumb = `/api/photos/thumb?folder=${encodeURIComponent(root)}&id=${encodeURIComponent(f.id)}&px=s220`; }
      out.push({
        id: f.id, name: f.name, t, ...(isVideo ? { video: true as const, ...(Number(vm.durationMillis) ? { dur: Math.round(Number(vm.durationMillis) / 1000) } : {}), ...(vm.width && vm.height ? { w: vm.width, h: vm.height } : {}) } : {}), ...(!t && f.createdTime ? { up: String(f.createdTime).slice(0, 19) } : {}), ...(name ? { dir: name } : {}), thumb,
        ...(loc && typeof loc.latitude === "number" && typeof loc.longitude === "number" && (loc.latitude || loc.longitude) ? { lat: +loc.latitude.toFixed(6), lng: +loc.longitude.toFixed(6) } : {}),
        // Width and height as the picture is shown (a phone photo stored sideways is turned by its rotation).
        ...(meta.width && meta.height ? (rot % 2 ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }) : {}),
      });
    }
    if (depth < MAX_DEPTH) for (const f of folders) await list(f.id, a, depth ? `${name}/${f.name}` : f.name, depth + 1, out, stats, root);
    pageToken = json.nextPageToken || "";
  } while (pageToken && out.length < MAX_PHOTOS);
}

/** The folder's name in Drive ("" when it can't be read: the list is still shown). */
async function folderName(id: string, a: Access) {
  try {
    const [url, init] = asked(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`, a);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    return res.ok ? String(((await res.json()) as any).name || "") : "";
  } catch { return ""; }
}

/** The photos in a shared folder (and its folders, two levels down), newest list from the last hour unless `refresh`. */
export async function folderPhotos(link: string, refresh = false): Promise<PhotoList> {
  // A folder on this computer: read from the disk (no key, no Google).
  if (isLocal(link)) return listLocal(link);
  const id = folderId(link);
  if (!id) throw new Error("That doesn't look like a Google Drive folder link. Open the folder in Drive, press Share and copy the link.");
  const a = await access();
  if (!a) throw new Error(NO_ACCESS);
  const hit = cache.data[id];
  // (A list made with the key has Google's own thumbnails, one made as the account the planner's: kept only for the same.)
  if (hit && !refresh && Date.now() - hit.at < MAX_AGE && !!hit.auth === "token" in a) return withVideoInfo(hit, a);
  const photos: Photo[] = [], stats = { total: 0 };
  let name = hit?.name || "";
  try { [name] = await Promise.all([name || folderName(id, a), list(id, a, "", 0, photos, stats)]); }
  catch (e) { if (hit) return withVideoInfo(hit, a); throw new Error(errMsg(e)); }
  photos.sort((a, b) => (a.t ? 0 : 1) - (b.t ? 0 : 1) || a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
  const out: PhotoList = { folder: id, name, at: Date.now(), photos, total: stats.total, truncated: stats.total > photos.length, ...("token" in a ? { auth: true } : {}) };
  cache.data[id] = out; cache.save(); thumbLinks.save();
  return withVideoInfo(out, a);
}

/** The type a browser can play a video as: a phone's .mov holds the same H.264 as an .mp4, but Drive says "quicktime", which
 *  most browsers then refuse. */
function videoType(id: string, list: PhotoList, upstream: string | null) {
  const p = list.photos.find((x) => x.id === id);
  if (!p?.video) return upstream || "image/jpeg";
  const ext = /\.([a-z0-9]+)$/i.exec(p.name)?.[1]?.toLowerCase() || "";
  return ext === "webm" ? "video/webm" : ["mp4", "m4v", "mov"].includes(ext) ? "video/mp4" : upstream || "video/mp4";
}

/**
 * The original file of a photo, streamed from Drive (the page can't ask Drive itself: the key stays here). Only photos
 * of a folder that was listed before: the key isn't handed out to fetch anything else.
 */
export async function photoFile(link: string, photoId: string, res: Res, range = ""): Promise<void> {
  if (isLocal(link)) return localFile(link, photoId, res, range);
  const folder = folderId(link), hit = cache.data[folder];
  if (!hit || !hit.photos.some((p) => p.id === photoId)) return sendJson(res, 404, { error: "That photo isn't in the folder." });
  const a = await access();
  if (!a) return sendJson(res, 400, { error: NO_ACCESS });
  // The stream stops when the viewer goes away (a video someone stops watching isn't downloaded to the end), and it can be
  // asked for any part of the file, which is how a video is played and sought in.
  const stop = new AbortController();
  res.on("close", () => stop.abort());
  const [url, init] = asked(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(photoId)}?alt=media&supportsAllDrives=true`, a, /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {});
  const r = await fetch(url, { ...init, signal: stop.signal });
  if ((!r.ok && r.status !== 206) || !r.body) return sendJson(res, r.status === 416 ? 416 : 502, { error: explain(r.status, await r.json().catch(() => ({}))) });
  const h = (n: string) => r.headers.get(n);
  res.writeHead(r.status === 206 ? 206 : 200, {
    "Content-Type": videoType(photoId, hit, h("content-type")),
    "Accept-Ranges": "bytes",
    ...(h("content-length") ? { "Content-Length": h("content-length")! } : {}),
    ...(h("content-range") ? { "Content-Range": h("content-range")! } : {}),
    // A photo doesn't change: the browser keeps it for a day.
    "Cache-Control": "private, max-age=86400",
  });
  Readable.fromWeb(r.body as any).on("error", () => res.destroy()).pipe(res);
}

/** A thumbnail of a photo read as the signed-in account, at `px` pixels (only photos of a folder listed before). */
export async function driveThumb(link: string, photoId: string, px: number, res: Res): Promise<void> {
  const folder = folderId(link), hit = cache.data[folder], src = thumbLinks.data[photoId];
  if (!hit || !src || !hit.photos.some((p) => p.id === photoId)) return sendJson(res, 404, { error: "That photo isn't in the folder." });
  const token = await bearer();
  if (!token) return sendJson(res, 400, { error: NO_ACCESS });
  const size = Math.max(64, Math.min(2048, Math.round(px) || 220));
  const r = await fetch(src.replace(/=s\d+(-[a-z]+)?$/i, "") + `=s${size}`, { headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  if (!r.ok || !r.body) return sendJson(res, 502, { error: `Google answered ${r.status}` });
  res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, max-age=86400" });
  Readable.fromWeb(r.body as any).on("error", () => res.destroy()).pipe(res);
}

// ---- Videos: where and when, from the file's own header (see video-header.ts). ------------------------------------------
export { localTime, readMoov, timeFromName } from "./video-header";

interface VideoInfo { lat?: number; lng?: number; /** Recording time, as local time where it was shot. */ t?: string; dur?: number; done: number }
const videoInfo = diskCache<VideoInfo>("video-meta.json");

async function driveRange(id: string, a: Access, start: number, len: number): Promise<Buffer | null> {
  const [url, init] = asked(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, a, { Range: `bytes=${start}-${start + len - 1}` });
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  if (res.status === 416 || !res.body) return null;
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  // A server that ignores the range sends the whole file: only what's asked for is read, then the rest is dropped.
  const chunks: Buffer[] = [];
  let got = 0;
  const reader = res.body.getReader();
  while (got < len) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); got += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, len);
}

/** What a Drive video's header says. */
async function readVideo(id: string, a: Access): Promise<VideoInfo> {
  return { ...(await readVideoHeader((start, len) => driveRange(id, a, start, len))), done: Date.now() };
}

const wait: string[] = [];
let reading = false;
const failedAt = new Map<string, number>();

/** Reads the headers of videos not read yet, one at a time, in the background. */
function readVideos(a: Access, ids: string[]) {
  for (const id of ids) if (!videoInfo.data[id] && !wait.includes(id) && Date.now() - (failedAt.get(id) || 0) > 10 * 60_000) wait.push(id);
  if (reading) return;
  reading = true;
  (async () => {
    while (wait.length) {
      const id = wait[0];
      try { videoInfo.data[id] = await readVideo(id, a); videoInfo.save(); }
      catch (e) { failedAt.set(id, Date.now()); console.error(`Reading a video's header failed: ${errMsg(e)}`); }
      wait.shift();
      await new Promise((r) => setTimeout(r, 150));
    }
  })().finally(() => { reading = false; });
}

/** The list with what the videos' headers said filled in (their place and time), and how many are still to be read. */
function withVideoInfo(list: PhotoList, a: Access): PhotoList {
  const videos = list.photos.filter((p) => p.video);
  if (!videos.length) return list;
  readVideos(a, videos.map((p) => p.id));
  let pending = 0;
  const photos = list.photos.map((p) => {
    if (!p.video) return p;
    const info = videoInfo.data[p.id];
    if (!info) { if (!failedAt.has(p.id)) pending++; return p; }
    return { ...p, ...(p.lat == null && info.lat != null ? { lat: info.lat, lng: info.lng } : {}), ...(!p.t && info.t ? { t: info.t } : {}) };
  });
  photos.sort((a, b) => (a.t ? 0 : 1) - (b.t ? 0 : 1) || a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
  return { ...list, photos, ...(pending ? { pending } : {}) };
}
