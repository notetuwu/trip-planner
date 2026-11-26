// The map's Photos layer: the photos of shared Google Drive folders (as many as the trip has), each as a small picture at
// the spot it was taken (from the photo's own GPS). Close ones are grouped into one picture with a count; a click opens
// the viewer on them. The server lists a folder (Drive API, needs the key in Settings → Planning); the thumbnails come
// straight from Google and the originals through the server. The folders belong to the trip (state.photoFolders).
import * as L from "leaflet";
import { api, apiUrl, esc } from "../core/dom";
import { type ViewItem, showGallery } from "../core/lightbox";
import { save, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";
import { cleanStop } from "../trip/modes";
import { type DayStops, type PhotoSpot, type Spot, anchorsOf, spotByTime, spotKey, withSpot } from "./photo-spot";
import { onMap } from "./travel-day";
import { editLine } from "../saves/collab";

interface Photo { id: string; name: string; lat?: number; lng?: number; t: string; up?: string; dir?: string; thumb: string; w?: number; h?: number; video?: true; dur?: number; rot?: number; /** Who uploaded it to Drive. */ by?: string }
interface PhotoList { folder: string; name: string; at: number; photos: Photo[]; total: number; truncated: boolean; pending?: number; skipped?: number }
/** What's known of one folder: its photos once loaded, or why not. */
interface Loaded { list: PhotoList | null; loading: boolean; error: string }

const STORE = "trip-planner-photos", GUESS = "trip-planner-photos-guess", HIDDEN = "trip-planner-photos-hidden";
/** How far apart (in screen pixels) two photos must be to be shown as separate pictures. */
const GRID = 62;

let on = localStorage.getItem(STORE) === "1", m: L.Map | null = null, layer: L.LayerGroup;
/** By the folder's link. */
const loaded = new Map<string, Loaded>();
/** Photos without a GPS position are put where the plan says they were at that time (on by default). */
let guess = localStorage.getItem(GUESS) !== "0";
const listeners = new Set<() => void>();
const changed = () => { for (const f of listeners) f(); };

/** The folders whose photos are hidden, by link: a choice of this computer's, never part of the trip (others who share
 *  it see their own), and only for the map, the gallery and the preview, not for placing photos. */
const hidden = new Set<string>((() => {
  try { const v = JSON.parse(localStorage.getItem(HIDDEN) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
})());
const keepHidden = () => localStorage.setItem(HIDDEN, JSON.stringify([...hidden]));

/** The trip's folders. A trip from the first version has its one folder in `photosFolder`: moved over here. A folder
 *  switched off in the trip itself (from before that was this computer's own choice) is hidden here instead. */
export function folders(): { link: string }[] {
  let moved = false;
  if (state.photosFolder) {
    if (!state.photoFolders?.some((f) => f.link === state.photosFolder)) state.photoFolders = [...(state.photoFolders || []), { link: state.photosFolder }];
    delete state.photosFolder;
    moved = true;
  }
  if (state.photoFolders?.some((f) => "off" in f)) {
    for (const f of state.photoFolders) if (f.off) hidden.add(f.link);
    keepHidden();
    state.photoFolders = state.photoFolders.map((f) => ({ link: f.link }));
    moved = true;
  }
  if (moved) save();
  return state.photoFolders || [];
}
/** The folders whose photos are shown here (the map, the gallery, the preview). */
const shownFolders = () => folders().filter((f) => !hidden.has(f.link));

export const isPhotosOn = () => on;
export const isPhotosGuess = () => guess;
export function setPhotosGuess(yes: boolean) {
  guess = yes;
  localStorage.setItem(GUESS, yes ? "1" : "0");
  draw(); changed();
}

/** A folder's photos with the spots given by hand applied. */
const placedByHand = (folder: string) => (loaded.get(folder)?.list?.photos || []).map((p) => { const key = spotKey(folder, p.id); return { ...withSpot(p, state.photoSpots?.[key]), key }; });

/** Places photos by hand (or marks them "can't place"); null takes that back. Returns what they had before, to undo. */
export function setSpots(changes: Record<string, PhotoSpot | null>): Record<string, PhotoSpot | null> {
  const spots = { ...state.photoSpots }, before: Record<string, PhotoSpot | null> = {};
  for (const [key, spot] of Object.entries(changes)) {
    before[key] = spots[key] || null;
    if (spot) spots[key] = spot; else delete spots[key];
  }
  if (Object.keys(spots).length) state.photoSpots = spots; else delete state.photoSpots;
  save(); draw(); changed();
  return before;
}

/** Looks up where a photo without a position was taken: by the trip's photos with a position taken around then (from all
 *  its shown folders), else where the plan has them at that time (the day's stops with a place on the map and a time, and
 *  where they slept). Built once for a whole list of photos. With the guess switched off, nothing is placed (unless
 *  `every`: placing photos by hand always gets suggestions). */
function placer(every = false): (t: string) => Spot | null {
  // (Placing photos, with `every`, always suggests: the switch is about the map putting them there by itself.)
  if (!guess && !every) return () => null;
  // Photos placed by hand count like those with a position of their own.
  const anchors = anchorsOf((every ? folders() : shownFolders()).flatMap((f) => placedByHand(f.link)));
  const days = planDays();
  return (t) => spotByTime(t, days, anchors);
}

/** Each day of the plan: its stops with a time and a place on the map, and where they slept. */
export function planDays(): DayStops[] {
  const it = state.itinerary;
  if (!it) return [];
  const byTitle = byTitleMap();
  return it.days.map((d) => {
    const stops: DayStops["stops"] = [];
    for (const x of d.items) {
      const tm = /^(\d{1,2}):(\d{2})/.exec(x.time || "");
      if (!tm || !onMap(x)) continue;
      const loc = itemLoc(x, d, byTitle);
      if (loc && !loc.elsewhere) stops.push({ min: +tm[1] * 60 + +tm[2], lat: loc.lat, lng: loc.lng, name: cleanStop(x.place) });
    }
    const s = stayOn(d), l = s ? stayLoc(s) : undefined;
    return { date: d.date, stops, ...(l && s ? { home: { lat: l.lat, lng: l.lng, name: s.hotel || s.city.split(",")[0] } } : {}) };
  });
}
export const onPhotosChange = (f: () => void) => { listeners.add(f); };
/** The trip on screen was replaced (another trip, or changes that came in from someone else): the layer, the gallery and
 *  placing photos show its spots. */
export function refreshPhotos() { if (layer) draw(); changed(); }

/** For the panel: each folder with its status, and the totals of what's shown. */
export function photosState() {
  const spot = placer();
  const rows = folders().map((f) => {
    const l = loaded.get(f.link), photos = l?.list?.photos || [];
    let shown = 0, guessed = 0, noSpot = 0;
    for (const p of placedByHand(f.link)) { if (p.lat != null) shown++; else if (!p.skipped && p.t && spot(p.t)) guessed++; else noSpot++; }
    return { link: f.link, local: isLocalFolder(f.link), skipped: l?.list?.skipped || 0, off: hidden.has(f.link), pending: l?.list?.pending || 0, videos: photos.filter((p) => p.video).length, name: l?.list?.name || "", loading: !!l?.loading, error: l?.error || "", total: l?.list?.total || 0, shown, guessed, noSpot, truncated: !!l?.list?.truncated };
  });
  const live = rows.filter((r) => !r.off), sum = (k: "shown" | "guessed" | "noSpot") => live.reduce((n, r) => n + r[k], 0);
  return { on, guess, rows, shown: sum("shown"), guessed: sum("guessed"), noSpot: sum("noSpot"), loading: rows.some((r) => r.loading) };
}

export function setPhotosOn(yes: boolean) {
  on = yes;
  localStorage.setItem(STORE, yes ? "1" : "");
  if (yes) loadMissing();
  draw(); changed();
}

/** A folder on this computer is kept in the trip as "local:<path>", so it sits in the same list as the Drive folders. */
export const isLocalFolder = (link: string) => /^local:/i.test(link);
const samePath = (a: string, b: string) => a.replace(/^local:/i, "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === b.replace(/^local:/i, "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

/** A pasted link, as the folder's id (so the same folder pasted twice, in different forms, is one). */
const idOf = (link: string) => link.match(/\/folders\/([\w-]{10,})/)?.[1] || link.match(/[?&]id=([\w-]{10,})/)?.[1] || link.trim().match(/^([\w-]{10,})$/)?.[1] || "";

/** Adds a folder to the trip; the reason when it can't be ("" when added). */
export function addPhotosFolder(link: string): string {
  link = link.trim();
  if (!link) return "";
  const id = idOf(link);
  if (!id) return "That doesn't look like a Google Drive folder link. Open the folder in Drive, press Share and copy the link.";
  if (folders().some((f) => idOf(f.link) === id)) return "That folder is already in the list.";
  state.photoFolders = [...folders(), { link }];
  save();
  loadMissing(); changed();
  return "";
}

/** Adds a folder from this computer to the trip; the reason when it can't be ("" when added). */
export function addLocalFolder(path: string): string {
  // A path copied from Explorer comes in quotes.
  path = path.trim().replace(/^["']+|["']+$/g, "");
  if (!path) return "";
  if (!/^([a-z]:[\\/]|\\\\|\/)/i.test(path)) return "Give the folder's full path, like D:\\Photos\\Italy, or press Choose folder.";
  if (folders().some((f) => isLocalFolder(f.link) && samePath(f.link, path))) return "That folder is already in the list.";
  state.photoFolders = [...folders(), { link: `local:${path}` }];
  save();
  loadMissing(); changed();
  return "";
}

export function removePhotosFolder(link: string) {
  state.photoFolders = folders().filter((f) => f.link !== link);
  if (!state.photoFolders.length) delete state.photoFolders;
  loaded.delete(link);
  save(); draw(); changed();
}

/** Shows or hides one folder's photos (it stays in the list), on this computer only: the trip doesn't change. */
export function setPhotosFolderShown(link: string, shown: boolean) {
  if (shown) hidden.delete(link); else hidden.add(link);
  keepHidden();
  if (shown) loadMissing();
  draw(); changed();
}

/** Loads the folders not loaded yet (and not hidden, unless `every`: placing photos uses them all); `refresh` asks
 *  Google again for all of them. */
export function loadMissing(refresh = false, every = false) {
  for (const f of folders()) {
    const have = loaded.get(f.link);
    if (hidden.has(f.link) && !refresh && !every) continue;
    if (have?.loading || (have?.list && !refresh)) continue;
    loadFolder(f.link, refresh);
  }
}

async function loadFolder(link: string, refresh: boolean, quiet = false) {
  const prev = loaded.get(link);
  // (Asking again for videos' places is quiet: the list stays as it is, with no "Loading…" each time.)
  if (!quiet) { loaded.set(link, { list: prev?.list || null, loading: true, error: "" }); changed(); }
  try {
    const got = await api<PhotoList>(`/api/photos?folder=${encodeURIComponent(link)}${refresh ? "&refresh=1" : ""}`);
    // Taken off the list meanwhile: that answer isn't wanted.
    if (folders().some((f) => f.link === link)) {
      loaded.set(link, { list: got, loading: false, error: "" });
      // Videos whose header the server is still reading get their place and time soon: ask again.
      if (got.pending) setTimeout(() => { if (folders().some((f) => f.link === link)) loadFolder(link, false, true); }, 6000);
    }
  } catch (e) { if (folders().some((f) => f.link === link)) loaded.set(link, { list: null, loading: false, error: (e as Error).message }); }
  draw(); changed();
}

/** "0:42", "1:05:09". */
export const duration = (s: number) => `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(s >= 3600 ? 2 : 1, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A thumbnail's address at the size wanted (Google's end in "=s220"). */
export const sized = (thumb: string, px: number) => {
  const u = thumb.replace(/=s\d+(-[a-z]+)?$/i, "") + `=s${px}`;
  // A picture from this computer comes from the planner's own server.
  return u.startsWith("/") ? apiUrl(u) : u;
};

/** A small picture of a photo. One from this computer has its preview turned upright (it's stored unrotated). */
export const thumbTag = (p: { thumb: string; rot?: number }, px: number, extra = "") =>
  `<img src="${esc(sized(p.thumb, px))}" alt="" ${extra} referrerpolicy="no-referrer" draggable="false"${p.rot && px <= 400 ? ` style="transform:rotate(${p.rot}deg)"` : ""}>`;

export const when = (t: string) => {
  const d = new Date(t.length > 10 ? t : `${t}T12:00:00`);
  return isNaN(+d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", ...(t.length > 10 ? { timeStyle: "short" } : {}) });
};

/** A photo with the folder it's from (its original comes through the server, by folder). */
export type Placed = Photo & {
  folder: string; folderName: string;
  /** What a spot given by hand is kept under. */ key: string;
  /** The file itself has a position. */ camera: boolean;
  /** Placed on the map by hand. */ placed?: boolean;
  /** Marked "can't place". */ skipped?: boolean;
  /** No GPS: put where the plan has them at that time. */ guessed?: boolean; near?: string;
};

/** The folder a photo is from (with the folder inside it, if any). */
export const folderOf = (p: Placed) => [p.folderName || p.folder.replace(/^local:/i, "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "", p.dir].filter(Boolean).join(" / ");
/** Where a photo came from: its folder, and who uploaded it when Drive says. */
export const sourceOf = (p: Placed) => [folderOf(p), p.by ? `uploaded by ${p.by}` : ""].filter(Boolean).join(" · ");

/** A photo as the viewer shows it: a big thumbnail at once, the original file from the server when it has loaded. */
export const viewItem = (p: Placed): ViewItem => ({
  src: sized(p.thumb, 2048),
  // A photo's original replaces its thumbnail; a video is played from the same route (the server passes on the seeking).
  ...(p.video
    ? {
      video: apiUrl(`/api/photos/image?folder=${encodeURIComponent(p.folder)}&id=${encodeURIComponent(p.id)}`),
      ...(isLocalFolder(p.folder) ? {} : { open: `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/view`, embed: `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/preview` }),
    }
    // From this computer the big picture already is the file: nothing to swap in.
    : isLocalFolder(p.folder) ? {} : { full: apiUrl(`/api/photos/image?folder=${encodeURIComponent(p.folder)}&id=${encodeURIComponent(p.id)}`) }),
  ...(p.rot ? { turn: p.rot } : {}),
  thumb: sized(p.thumb, 160),
  caption: [p.video ? `Video${p.dur ? ` ${duration(p.dur)}` : ""} · ${p.name}` : p.name, when(p.t), sourceOf(p), p.guessed ? `placed by its time, near ${p.near}` : "", p.placed ? editLine(`photo:${p.key}`, "placed by hand") || "placed by hand" : "", !p.t && p.up ? `no camera time (uploaded ${when(p.up)})` : ""].filter(Boolean).join(" · "),
});

/** Every photo of the trip's shown folders (`every`: of all its folders, hidden here or not), with or without a spot, in
 *  the order they were taken. */
export function allPhotos(every = false): Placed[] {
  const out: Placed[] = [], spot = placer(every);
  for (const f of every ? folders() : shownFolders()) {
    const l = loaded.get(f.link)?.list;
    for (const p of placedByHand(f.link)) {
      const s = p.lat == null && !p.skipped && p.t ? spot(p.t) : null;
      out.push({ ...p, folder: f.link, folderName: l?.name || "", ...(s ? { lat: s.lat, lng: s.lng, guessed: true, near: s.near } : {}) });
    }
  }
  // In the order taken, those with no time last.
  return out.sort((a, b) => (a.t ? 0 : 1) - (b.t ? 0 : 1) || a.t.localeCompare(b.t) || a.name.localeCompare(b.name));
}

/** Puts the photos in view on the map, grouped by how close they are on screen. */
function draw() {
  layer.clearLayers();
  if (!on || !m) return;
  // The shown folders' photos with a spot, from all of them together (so a group can hold photos of several folders).
  const all = allPhotos().filter((p) => p.lat != null);
  // A trip opened that has folders not loaded yet: they load now.
  if (shownFolders().some((f) => !loaded.has(f.link))) loadMissing();
  const b = m.getBounds().pad(0.25), z = m.getZoom();
  const cells = new Map<string, { photos: Placed[]; lat: number; lng: number }>();
  for (const p of all) {
    if (!b.contains([p.lat!, p.lng!])) continue;
    const pt = m.project([p.lat!, p.lng!], z), key = `${Math.floor(pt.x / GRID)}_${Math.floor(pt.y / GRID)}`;
    const c = cells.get(key) || { photos: [], lat: 0, lng: 0 };
    c.photos.push(p); c.lat += p.lat!; c.lng += p.lng!;
    cells.set(key, c);
  }
  for (const c of cells.values()) {
    const n = c.photos.length, first = c.photos[0], at: L.LatLngExpression = n === 1 ? [first.lat!, first.lng!] : [c.lat / n, c.lng / n];
    const guessed = c.photos.every((p) => p.guessed);
    const html = `<div class="photo-pin${n > 1 ? " many" : ""}${guessed ? " guess" : ""}">${thumbTag(first, 128)}${n === 1 && first.video ? `<i class="photo-play"></i>` : ""}${n > 1 ? `<b>${n}</b>` : ""}</div>`;
    const mk = L.marker(at, { pane: "photos", keyboard: false, bubblingMouseEvents: false, icon: L.divIcon({ className: "", html, iconSize: [52, 52], iconAnchor: [26, 26] }) })
      .bindTooltip(n === 1 ? `${first.video ? "Video · " : ""}${esc(first.name)}<br><span class="pop-meta">${first.video && first.dur ? `${esc(duration(first.dur))} · ` : ""}${esc(when(first.t))}${first.guessed ? `<br>Placed by its time, near ${esc(first.near)}` : ""}</span>` : `${n} photos${guessed ? " (placed by their time)" : ""}`, { direction: "top", offset: [0, -24], className: "leg-tip" })
      .addTo(layer);
    mk.on("click", () => {
      // One photo, or a group: its photos to go through, in the order they were taken, with a strip of them along the bottom.
      const sorted = [...c.photos].sort((a, b) => a.t.localeCompare(b.t));
      showGallery(sorted.map(viewItem), 0);
    });
  }
}

/** Sets up the layer (called once the map exists). */
export function initPhotos(map: L.Map) {
  m = map;
  // Over the transport lines and stops, under the day's own pins.
  map.createPane("photos").style.zIndex = "420";
  layer = L.layerGroup().addTo(map);
  map.on("moveend", draw);
  if (on) loadMissing();
}
