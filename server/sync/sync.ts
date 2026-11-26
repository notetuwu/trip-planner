// Trips kept in step with Google Drive folders (Settings → Sync).
//
// Each synced trip carries a `sync` block (TripShare: its id, who shared it, "edit" or "view"). Per trip and folder this
// computer remembers which Drive file it is, the file's checksum when they were last the same, and what the save held then.
// Each round compares the three:
//  - changed only here: uploaded (if it may be changed: the person who shared it, or shared as "can edit", with edit
//    access to the folder in Drive);
//  - changed only in Drive: downloaded into the save (what the save held is kept as a version first);
//  - changed in both: the two are joined (shared/merge.ts: what each side changed, against what both had last); only when
//    both changed the same thing differently is nothing overwritten: the trip shows the clash in Your trips and the person
//    picks which to keep (the other one is kept as a version). A view-only trip someone else shared always takes Drive's.
//  - Drive can't refuse a save made from an older version, so two saves at nearly the same moment would leave only the
//    last: each file notes the versions it was made from (`lineage`), and a computer that finds its own last upload
//    saved over without having been seen joins its changes back in (from what the file held before that upload).
//
// What it never does: delete or trash anything in Drive (a trip deleted here, or a folder removed in Settings, only stops
// syncing; the file stays in the folder), touch files outside the sync folders, or send this computer's details along
// (photo folders on this disk, place lists' file paths, the prompt and the model's thinking are left out of the file),
// or each person's own settings (shared/edits.ts PERSONAL: never sent, never taken).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SyncFolder, SyncStatus, TripShare, TripSyncInfo } from "../../shared/types";
import { SAVES_DIR, VERSION, cleanName, errMsg } from "../config";
import { isLocal } from "../geo/local-photos";
import { cleanBundledList, readList, writeList } from "../lists/store";
import { keepVersion, keepVersionText, stable } from "../util/versions";
import { PERSONAL, mergeTrip, partOfPath } from "../../shared/edits";
import * as g from "./google";
import * as store from "./store";
import * as box from "./dropbox";
import { fsCheck } from "../util/fs-browse";
import { KIND_LABEL, folderKind } from "../util/folder-kind";

/** Whether there's anything to sync with now: Drive (signed in), or a folder on this computer. */
const canSync = () => store.driveReady() || state().folders.some((f) => store.ready(store.providerOf(f.id)));

const STATE_FILE = () => path.join(g.SYNC_DIR, "state.json");
const CACHE_DIR = () => path.join(g.SYNC_DIR, "cache");
/** What a file held when this computer and Drive last had the same trip: the starting point for joining two sides' changes. */
const BASE_DIR = () => path.join(g.SYNC_DIR, "base");
function setBase(fileId: string, text: string) {
  if (!fileId) return;
  fs.mkdirSync(BASE_DIR(), { recursive: true });
  fs.writeFileSync(path.join(BASE_DIR(), `${store.fileKey(fileId)}.json`), text);
}
function readBase(fileId: string): string | null {
  try { return fileId ? fs.readFileSync(path.join(BASE_DIR(), `${store.fileKey(fileId)}.json`), "utf8") : null; } catch { return null; }
}
/** What the file held before this computer's last upload over it (its checksum and text): the starting point for joining
 *  again when someone saved over that upload without having seen it (see overwritten). */
const PREV_DIR = () => path.join(g.SYNC_DIR, "base-prev");
function setPrev(fileId: string, md5: string, text: string | null) {
  if (!fileId) return;
  const file = path.join(PREV_DIR(), `${store.fileKey(fileId)}.json`);
  if (!text || !md5) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(PREV_DIR(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ md5, text }));
}
function readPrev(fileId: string): { md5: string; text: string } | null {
  try { const p = JSON.parse(fs.readFileSync(path.join(PREV_DIR(), `${store.fileKey(fileId)}.json`), "utf8")); return typeof p?.md5 === "string" && typeof p?.text === "string" ? p : null; } catch { return null; }
}
/** The checksums of the versions a file's trip was made from, newest first (written by this app since 3.29; none in older
 *  files, which are then trusted as before). */
function lineageOf(text: string | null): string[] | null {
  try { const l = text ? JSON.parse(text)?.lineage : null; return Array.isArray(l) ? l.filter((x: unknown) => typeof x === "string") : null; } catch { return null; }
}
const LINEAGE = 30;
/** The trip in a file's text, as it's compared (without its sync block, which each side keeps for itself). */
function tripOfText(text: string): any {
  const data = JSON.parse(text), trip = data?.format === FORMAT ? data.trip : data;
  const { sync: _s, ...rest } = trip || {};
  return rest;
}
export const FORMAT = "trip-planner-trip";
const ROUND_MS = 3 * 60_000;

interface Link {
  /** The trip's file in the folder ("" until it's first uploaded). */
  fileId: string;
  /** The file's checksum when this computer and Drive last had the same trip. */
  md5: string;
  /** What the save held then (a hash of its text). */
  local: string;
  /** Changed in both places: the Drive version waiting for a decision. */
  conflict?: { md5: string; by: string; at: string };
  /** The version agreed on (md5) was uploaded from here: a newer one that wasn't made from it lost this computer's changes. */
  ours?: boolean;
}
interface Tracked { folders: Record<string, Link>; /** The trip's share as Drive last had it (who shared it, edit or view). */ share?: TripShare | null; error?: string }
interface RemoteFile { id: string; name: string; md5: string; at: string; by: string; byEmail: string; canEdit: boolean; tripId: string }
interface SyncState {
  folders: SyncFolder[];
  trips: Record<string, Tracked>;
  /** What each folder held at the last look. */
  remote: Record<string, { at: number; files: RemoteFile[] }>;
  /** When sync last wrote Drive's version into a save, by save name (the page reloads the trip it has open). */
  updated: Record<string, number>;
  notices: string[];
}

let st: SyncState | null = null;
function state(): SyncState {
  if (st) return st;
  let s: Partial<SyncState> = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")); } catch { /* none yet */ }
  st = { folders: Array.isArray(s.folders) ? s.folders : [], trips: s.trips && typeof s.trips === "object" ? s.trips : {}, remote: s.remote || {}, updated: s.updated || {}, notices: Array.isArray(s.notices) ? s.notices : [] };
  return st;
}
function save() {
  fs.mkdirSync(g.SYNC_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE(), JSON.stringify(state(), null, 1));
}
function notice(text: string) {
  const s = state();
  s.notices = [text, ...s.notices.filter((n) => n !== text)].slice(0, 10);
}

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
/** What a save holds, as a fingerprint of its content rather than its text: the page writes the same trip with its keys in
 *  another order, which must not count as a change (two computers would send the trip back and forth for ever). */
export function key(text: string): string {
  try { const { saveName: _n, ...trip } = JSON.parse(text); return hash(stable(trip)); } catch { return hash(text); }
}
const sameEmail = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
export const fileName = (saveName: string) => `${saveName}${g.TRIP_SUFFIX}`;
/** A trip's name from its file's: without ".trip.json" or ".json". */
export const tripName = (file: string) => file.replace(/(\.trip)?\.json$/i, "");

export function cleanShare(s: any): TripShare | null {
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !/^[\w-]{8,64}$/.test(s.id)) return null;
  const ownerName = typeof s.ownerName === "string" ? s.ownerName.slice(0, 200) : "";
  return { id: s.id, owner: typeof s.owner === "string" ? s.owner.slice(0, 200) : "", ...(ownerName ? { ownerName } : {}), mode: s.mode === "view" ? "view" : "edit" };
}

// ---- Saves on this computer ----------------------------------------------------------------------------------------------
interface Local { name: string; file: string; text: string; trip: any }

function readLocal(name: string): Local | null {
  const clean = cleanName(name);
  if (!clean) return null;
  const file = path.join(SAVES_DIR, `${clean}.json`);
  try { const text = fs.readFileSync(file, "utf8"); return { name: clean, file, text, trip: JSON.parse(text) }; } catch { return null; }
}

let scan: { sig: string; byId: Map<string, Local> } | null = null;
/** The saves that are shared trips, by the trip's id (read again only when a save changed). */
function localsById(): Map<string, Local> {
  let files: { f: string; m: number; s: number }[] = [];
  try { files = fs.readdirSync(SAVES_DIR).filter((f) => f.endsWith(".json")).map((f) => { const st = fs.statSync(path.join(SAVES_DIR, f)); return { f, m: st.mtimeMs, s: st.size }; }); } catch { /* none */ }
  const sig = files.map((x) => `${x.f}:${x.m}:${x.s}`).join("|");
  if (scan?.sig === sig) return scan.byId;
  const byId = new Map<string, Local & { m: number }>();
  for (const { f, m } of files) {
    const l = readLocal(f.slice(0, -5));
    const id = cleanShare(l?.trip?.sync)?.id;
    // Two saves of one trip (a copy made by hand): the newest is the one that syncs.
    if (l && id && (!byId.has(id) || byId.get(id)!.m < m)) byId.set(id, { ...l, m });
  }
  scan = { sig, byId };
  return byId;
}

/** Writes a save. `keep`: what it held is kept as a version first ("always": whatever the last version was; otherwise at
 *  most one every 10 minutes, so a friend editing all afternoon doesn't push out the older versions). */
function writeLocal(name: string, trip: any, { keep = "always" as "always" | "spaced" | false, fromDrive = true } = {}): string {
  const clean = cleanName(name), file = path.join(SAVES_DIR, `${clean}.json`);
  fs.mkdirSync(SAVES_DIR, { recursive: true });
  if (keep) keepVersion(SAVES_DIR, clean, file, keep === "always");
  const text = JSON.stringify({ ...trip, saveName: clean });
  if (fromDrive) {
    // What the page may still have on screen: its changes are joined with this one when it writes (see pageWrite). The last
    // few, so a page that missed more than one update (a tab in the background) is still joined, not refused.
    try { replaced.set(clean, [{ text: fs.readFileSync(file, "utf8"), at: state().updated[clean] || 0 }, ...(replaced.get(clean) || [])].slice(0, 8)); } catch { replaced.delete(clean); }
  }
  fs.writeFileSync(file, text);
  if (fromDrive) state().updated[clean] = Date.now();
  return text;
}

/** By save name: what the save held before sync wrote Drive's versions into it, and the stamp it had then (newest first). */
const replaced = new Map<string, { text: string; at: number }[]>();

function freeName(base: string) {
  const b = (cleanName(base) || "Shared trip").slice(0, 70);
  let n = b;
  for (let i = 2; fs.existsSync(path.join(SAVES_DIR, `${n}.json`)); i++) n = `${b} ${i}`;
  return n;
}

// ---- The trip as a file in Drive -----------------------------------------------------------------------------------------
type BundledPlace = { title: string; note?: string; url?: string; tags?: string; comment?: string; address?: string; lat?: number; lng?: number };
const placeOf = ({ title, note, url, tags, comment, address, lat, lng }: BundledPlace) => ({ title, note, url, tags, comment, address, lat, lng });
const listNames = (trip: any): string[] => (Array.isArray(trip?.lists) ? trip.lists.map(String) : trip?.list ? [String(trip.list)] : []);

/** The trip as it goes into a folder: like Export (the ticked place lists go along), minus what only matters on this
 *  computer: the prompt and thinking, photo folders on this disk, list file paths, and each person's own settings
 *  (shared/edits.ts PERSONAL). `lineage`: the checksums of the versions it was made from, newest first. */
export function toSharedText(trip: any, share: TripShare, lineage?: string[]): string {
  const { meta, saveName: _n, photoFolders, photosFolder, sync: _s, ...all } = trip || {};
  const rest = { ...all };
  for (const k of PERSONAL) delete rest[k];
  const lean = meta && typeof meta === "object" ? (({ prompt: _p, thinking: _t, ...m }) => m)(meta) : null;
  const lists = listNames(trip).map((n) => readList(n)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => ({
    name: l.name, title: l.title, ...(l.source?.type === "google" ? { source: l.source } : {}), places: l.places.map(placeOf),
  }));
  // Must-sees from those lists go along as kept places too (the other side may not keep the list).
  const kept: BundledPlace[] = Array.isArray(trip?.kept) ? [...trip.kept] : [];
  for (const l of lists) for (const p of l.places) if (trip?.marks?.[p.title] === "must" && !kept.some((k) => k.title === p.title)) kept.push(p);
  // (Only the link: which folders are shown is each computer's own choice.)
  const drivePhotos = (Array.isArray(photoFolders) ? photoFolders : []).filter((f: any) => f && typeof f.link === "string" && !isLocal(f.link)).map((f: any) => ({ link: f.link }));
  return JSON.stringify({
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    ...(lineage?.length ? { lineage: lineage.slice(0, LINEAGE) } : {}),
    trip: { ...rest, kept, meta: lean, photoFolders: drivePhotos, ...(typeof photosFolder === "string" && photosFolder && !isLocal(photosFolder) ? { photosFolder } : {}), sync: share },
    lists,
  }, null, 1);
}

/** A trip file from Drive as a save on this computer: its missing place lists are added (made safe: see
 *  cleanBundledList), and what belongs to this computer stays as it was here (photo folders on this disk, the models). */
export function fromSharedText(text: string, local: any | null, name: string): any {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("The file in Drive isn't a trip (it can't be read)."); }
  const trip = data?.format === FORMAT ? data.trip : data;
  if (!trip || typeof trip !== "object" || !Array.isArray(trip.stays)) throw new Error("The file in Drive isn't a trip (no stays in it).");
  for (const l of Array.isArray(data?.lists) ? data.lists : []) {
    if (!l || typeof l.name !== "string" || readList(l.name)) continue;
    const clean = cleanBundledList(l.name, l);
    if (clean) writeList(clean);
  }
  const lists = listNames(trip).filter((n) => readList(n));
  const out: any = { ...trip, lists, list: lists[0] || "", listChosen: true, saveName: cleanName(name) };
  // Photo folders on another computer mean nothing here (and must never point at folders on this one).
  const own = (Array.isArray(local?.photoFolders) ? local.photoFolders : []).filter((f: any) => f && isLocal(f.link));
  // Which folders are shown is this computer's own choice (kept outside the trip), never the other side's.
  out.photoFolders = [...(Array.isArray(trip.photoFolders) ? trip.photoFolders : []).filter((f: any) => f && typeof f.link === "string" && !isLocal(f.link)).map((f: any) => ({ link: f.link })), ...own];
  if (typeof out.photosFolder !== "string" || isLocal(out.photosFolder)) delete out.photosFolder;
  // Each person's own settings stay as they are here (the models picked here, which the other computer may not have; what
  // the chat may do by itself; how plans are made), and are never taken from the file (an older app put them in).
  for (const k of PERSONAL) { if (local?.[k] !== undefined) out[k] = local[k]; else delete out[k]; }
  return out;
}

// ---- Folders -------------------------------------------------------------------------------------------------------------
async function content(id: string, md5: string): Promise<{ text: string; md5: string }> {
  const file = path.join(CACHE_DIR(), `${store.fileKey(id)}.json`);
  try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (md5 && c.md5 === md5) return c; } catch { /* not kept yet */ }
  const text = await store.download(id);
  const c = { md5: md5 || crypto.createHash("md5").update(text).digest("hex"), text };
  fs.mkdirSync(CACHE_DIR(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
  return c;
}

async function refreshFolder(f: SyncFolder): Promise<RemoteFile[] | null> {
  const p = store.providerOf(f.id);
  if (!store.ready(p)) { f.error = store.notReady(p); return null; }
  try {
    const info = await store.folderInfo(f.id);
    f.name = info.name; f.canWrite = info.canWrite;
    const out: RemoteFile[] = [];
    for (const d of await store.listTripFiles(f.id)) {
      const md5 = d.md5Checksum || "";
      let tripId = d.properties?.tripPlannerId || "";
      try { const c = await content(d.id, md5); const data = JSON.parse(c.text); tripId = cleanShare((data?.format === FORMAT ? data.trip : data)?.sync)?.id || tripId; }
      catch { /* unreadable: listed, but it can't be opened */ }
      out.push({ id: d.id, name: d.name, md5, at: d.modifiedTime || "", by: d.lastModifyingUser?.displayName || d.lastModifyingUser?.emailAddress || "", byEmail: d.lastModifyingUser?.emailAddress || "", canEdit: d.capabilities?.canEdit !== false, tripId });
    }
    f.error = undefined;
    state().remote[f.id] = { at: Date.now(), files: out };
    return out;
  } catch (e) {
    f.error = errMsg(e);
    return null;
  }
}

/** Adds a sync folder: a Google Drive folder (its link or id) or a folder on this computer ("local:<path>", or the path). */
export async function addFolder(link: string, label: string): Promise<SyncFolder> {
  const text = String(link || "").trim();
  // Dropbox: a folder from the browser (one shared with you is added to your Dropbox), or its shared link.
  const dropboxLink = /dropbox\.com\/(scl\/fo|sh)\//i.test(text);
  if ((text.startsWith(box.PREFIX) || dropboxLink) && !box.ready()) throw new Error("Sign in to Dropbox first (Settings → Sync) to use a Dropbox folder.");
  const id = text.startsWith(box.PREFIX) ? await box.resolveFolder(text) : dropboxLink ? await box.folderFromLink(text) : folderIdOf(text);
  if (!id) throw new Error("That isn't a Google Drive or Dropbox folder link, or a folder on this computer.");
  const p = store.providerOf(id);
  if (!store.ready(p)) throw new Error(p === "drive" ? "Sign in with Google first (Settings → Sync) to use a Google Drive folder." : store.notReady(p));
  return putFolder(await store.folderInfo(id), label);
}
export async function newFolder(name: string, label: string): Promise<SyncFolder> {
  const clean = String(name || "").trim().slice(0, 100) || "Trip Planner trips";
  return putFolder(await g.createFolder(clean), label || clean);
}
async function putFolder(info: { id: string; name: string; canWrite: boolean }, label: string) {
  const s = state(), was = s.folders.find((f) => f.id === info.id);
  const kind = store.isLocalId(info.id) ? KIND_LABEL[await folderKind(info.id.slice(6))] : undefined;
  const f: SyncFolder = { id: info.id, name: info.name, label: String(label || "").trim().slice(0, 60) || was?.label || info.name, canWrite: info.canWrite, ...(kind ? { kind } : {}) };
  s.folders = was ? s.folders.map((x) => (x.id === f.id ? f : x)) : [...s.folders, f];
  save();
  runSync();
  return f;
}
export function renameFolder(id: string, label: string) {
  const f = state().folders.find((x) => x.id === id);
  if (f && label.trim()) { f.label = label.trim().slice(0, 60); save(); }
}
/** Stops using a folder here: its trips stop syncing to it. Nothing in Drive changes. */
export function removeFolder(id: string) {
  const s = state();
  s.folders = s.folders.filter((f) => f.id !== id);
  for (const t of Object.values(s.trips)) delete t.folders[id];
  delete s.remote[id];
  save();
}

/** A folder's id from what they pasted: a share link ("…/folders/ID?usp=sharing", "…/open?id=ID"), or the id itself. */
export function folderIdOf(link: string): string {
  const s = String(link || "").trim();
  // A folder on this computer: "local:<path>", or a path as pasted (C:\…, \\server\share, /Users/…, ~/…).
  const p = s.replace(/^local:/i, "");
  if (/^local:/i.test(s) || /^([a-z]:[\\/]|\\\\|\/|~[\\/]?|file:\/\/)/i.test(p)) {
    try { return store.isLocalId(`local:${fsCheck(p).path}`) ? `local:${fsCheck(p).path}` : ""; } catch { return ""; }
  }
  const m = s.match(/\/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/);
  return m && g.isDriveId(m[1]) ? m[1] : "";
}

// ---- Who may change a trip -----------------------------------------------------------------------------------------------
function rights(t: Tracked | undefined, local: Local | null) {
  const me = store.me(), localShare = cleanShare(local?.trip?.sync), known = t?.share || localShare;
  // Not shared yet: theirs. Shared with no owner known (a file put in a folder by someone Google doesn't name): nobody's,
  // so "view only" can't be got round that way.
  const mine = !known || (!!known.owner && me.ids.some((id) => sameEmail(known.owner, id)));
  // The person who shared it decides edit or view (their own save says which); for everyone else, Drive's copy does.
  const share = mine ? localShare || known : known;
  return { mine, share, editable: mine || share?.mode !== "view" };
}

// ---- A round ---------------------------------------------------------------------------------------------------------------
let current: Promise<void> | null = null, again = false, lastRun = 0, lastError = "";

/** Brings every synced trip up to date with its folders. Only one round runs at a time: asked while one runs, it goes once
 *  more when that's done, and the answer comes after both. */
export function runSync(): Promise<void> {
  if (!canSync()) return Promise.resolve();
  if (current) { again = true; return current; }
  current = (async () => {
    try {
      do { again = false; await round(); } while (again);
      lastError = "";
    } catch (e) { lastError = errMsg(e); }
    finally { current = null; lastRun = Date.now(); try { save(); } catch { /* kept in memory */ } }
  })();
  return current;
}

async function round() {
  const s = state(), remote = new Map<string, RemoteFile[]>();
  for (const f of [...s.folders]) { const files = await refreshFolder(f); if (files) remote.set(f.id, files); }
  const locals = localsById();
  for (const [id, t] of Object.entries(s.trips)) {
    let local: Local | undefined = locals.get(id);
    // Not found: being renamed, or written by a page just now; it's back next round. (Deleting a save stops its syncing.)
    if (!local) continue;
    t.error = undefined;
    for (const [folderId, link] of Object.entries(t.folders)) {
      if (!s.folders.some((f) => f.id === folderId)) { delete t.folders[folderId]; continue; }
      const files = remote.get(folderId);
      if (!files) continue; // the folder couldn't be read this time (offline): next round
      try { local = await syncLink(id, t, folderId, link, local, files); }
      catch (e) { t.error = errMsg(e); }
    }
  }
}

async function syncLink(id: string, t: Tracked, folderId: string, link: Link, local: Local, files: RemoteFile[]): Promise<Local> {
  const s = state(), folder = s.folders.find((f) => f.id === folderId)!;
  const { mine, share, editable } = rights(t, local);
  if (!share) return local;
  const localHash = key(local.text);
  let remote = link.fileId ? files.find((f) => f.id === link.fileId) : undefined;

  if (!remote) {
    if (link.fileId) {
      // Removed from the folder in Drive (or moved): it isn't put back.
      delete t.folders[folderId];
      notice(`"${local.name}" was removed from "${folder.label}" in Drive, so it doesn't sync there anymore.`);
      return local;
    }
    const there = files.find((f) => f.tripId === id);
    if (there) {
      // The folder already has this trip (it was put there from elsewhere): this computer's version goes up, Drive's is
      // kept as a version here first. If it may not be changed from here, Drive's comes down instead.
      link.fileId = there.id; link.md5 = there.md5; link.local = ""; link.ours = false;
      remote = there;
      if (editable && folder.canWrite && there.canEdit) {
        try {
          const c = await content(there.id, there.md5);
          setBase(there.id, c.text);
          keepVersionText(SAVES_DIR, local.name, JSON.stringify(fromSharedText(c.text, local.trip, local.name)));
        } catch { /* unreadable: Drive keeps its versions too */ }
      } else return applyRemote(id, t, link, local, remote);
    } else {
      if (!editable || !folder.canWrite) {
        delete t.folders[folderId];
        notice(`"${local.name}" can't be added to "${folder.label}": ${!folder.canWrite ? "you can only view that folder in Drive" : "it's shared with you as view only"}.`);
        return local;
      }
      const text = toSharedText(local.trip, share);
      const up = await store.upload({ folder: folderId, name: fileName(local.name), text, properties: { tripPlannerId: id } });
      link.fileId = up.id; link.md5 = up.md5Checksum || ""; link.local = localHash; link.ours = true;
      setBase(up.id, text);
      return local;
    }
  }

  const remoteChanged = remote.md5 !== link.md5, localChanged = localHash !== link.local;
  if (link.conflict) {
    // Waiting for the person to pick; who and when follow Drive if it changed again.
    if (remote.md5 !== link.conflict.md5) link.conflict = { md5: remote.md5, by: remote.by, at: remote.at };
    return local;
  }
  if (!remoteChanged && !localChanged) return local;
  const canUpload = editable && folder.canWrite && remote.canEdit;
  // Someone saved over this computer's last upload without having seen it (two saves at nearly the same moment: Drive keeps
  // the last one whole, it can't refuse it). This computer's changes aren't lost: they're joined with theirs again, from
  // what the file held before that upload; when that isn't known or they clash, the person picks (both are kept).
  if (remoteChanged && link.ours && canUpload) {
    const lineage = lineageOf((await content(remote.id, remote.md5)).text);
    if (lineage && !lineage.includes(link.md5)) {
      const prev = readPrev(link.fileId);
      const joined = prev && lineage.includes(prev.md5) ? await joinBoth(id, t, link, local, remote, share, mine, prev.text) : null;
      if (joined) return joined;
      link.conflict = { md5: remote.md5, by: remote.by, at: remote.at };
      return local;
    }
  }
  if (localChanged && !remoteChanged) {
    // Changes that may not go to Drive (view only, or no edit access there) stay on this computer.
    // The file follows the save's name, for the person who shared it (a file put there by hand keeps its own).
    if (canUpload) await uploadTo(id, link, local, share, mine && remote.name.toLowerCase().endsWith(g.TRIP_SUFFIX) ? fileName(local.name) : remote.name);
    return local;
  }
  if (!localChanged || !canUpload) return applyRemote(id, t, link, local, remote);
  // Changed on both sides: joined when they changed different things.
  const joined = await joinBoth(id, t, link, local, remote, share, mine);
  if (joined) return joined;
  link.conflict = { md5: remote.md5, by: remote.by, at: remote.at };
  return local;
}

/** This computer's and Drive's changes together (against what both had last), written here and sent to Drive; null when
 *  they changed the same thing differently, or what both had last isn't known (then the person picks). */
async function joinBoth(id: string, t: Tracked, link: Link, local: Local, remote: RemoteFile, share: TripShare, mine: boolean, from?: string): Promise<Local | null> {
  const base = from ?? readBase(link.fileId);
  if (!base) return null;
  const c = await content(remote.id, remote.md5);
  let m;
  try { m = mergeTrip(tripOfText(base), tripOfText(toSharedText(local.trip, share)), tripOfText(c.text)); } catch { return null; }
  if (m.clashes.length) return null;
  // The page wrote the save since this round read it: the next round joins that too.
  if (fs.existsSync(local.file) && key(fs.readFileSync(local.file, "utf8")) !== key(local.text)) return local;
  let lists: unknown = [];
  try { lists = JSON.parse(c.text)?.lists || []; } catch { /* none */ }
  const trip = fromSharedText(JSON.stringify({ format: FORMAT, trip: m.value, lists }), local.trip, local.name);
  trip.sync = mine ? local.trip.sync : (t.share || share);
  const text = writeLocal(local.name, trip, { keep: "always" });
  // Drive's version is the starting point now: the joined trip goes up over it.
  link.md5 = remote.md5; link.local = "";
  setBase(remote.id, c.text);
  const joined = { ...local, text, trip };
  await uploadTo(id, link, joined, share, remote.name.toLowerCase().endsWith(g.TRIP_SUFFIX) && mine ? fileName(local.name) : remote.name);
  return joined;
}

async function uploadTo(id: string, link: Link, local: Local, share: TripShare, name: string) {
  // Someone saved it in Drive since the folder was looked at: not overwritten (the next round sees their change).
  const fresh = await store.fileMeta(link.fileId);
  if ((fresh.md5Checksum || "") !== link.md5 || fresh.trashed) return;
  // The version it replaces (what the file holds now), and the ones that one was made from: another computer can tell from
  // them whether this was made from its own last upload (see syncLink).
  const was = readBase(link.fileId);
  const text = toSharedText(local.trip, share, [link.md5, ...(lineageOf(was) || [])].filter(Boolean));
  const up = await store.upload({ id: link.fileId, name, text, properties: { tripPlannerId: id } });
  setPrev(link.fileId, link.md5, was);
  link.md5 = up.md5Checksum || ""; link.local = key(local.text); link.ours = true;
  setBase(link.fileId, text);
}

/** Drive's version becomes the save (what the save held is kept as a version first). */
async function applyRemote(id: string, t: Tracked, link: Link, local: Local, remote: RemoteFile): Promise<Local> {
  const c = await content(remote.id, remote.md5);
  const trip = fromSharedText(c.text, local.trip, local.name);
  // A file without a sync block (put there by hand, or exported again over the old one) is still this trip.
  const theirs = cleanShare(trip.sync) || cleanShare(t.share || local.trip.sync);
  if (theirs?.id !== id) throw new Error(`The file "${remote.name}" in Drive holds another trip now.`);
  const { mine } = rights(t, local);
  if (mine) trip.sync = local.trip.sync; // the person who shared it decides edit or view, not the file
  else {
    // Who shared it doesn't change (a file edited by hand can't make someone else the owner).
    if (t.share?.owner && !sameEmail(theirs.owner, t.share.owner)) theirs.owner = t.share.owner;
    t.share = theirs; trip.sync = theirs;
  }
  // The page wrote the save since this round read it: that's a change here too, so the next round decides.
  if (fs.existsSync(local.file) && key(fs.readFileSync(local.file, "utf8")) !== key(local.text)) return local;
  // Changes made here that may not go to Drive (view only) are always kept as a version; otherwise what the save held is
  // already in Drive or an earlier version, so one every 10 minutes is enough.
  const text = writeLocal(local.name, trip, { keep: key(local.text) !== link.local ? "always" : "spaced" });
  link.md5 = remote.md5; link.local = key(text); link.ours = false;
  setBase(remote.id, c.text);
  return { ...local, text, trip };
}

// ---- What the page asks ----------------------------------------------------------------------------------------------------
/** Which folders a trip syncs to, and (for the person who shared it) edit or view. Folders are only added for a trip that
 *  may be changed from here; unticking one stops syncing there (the file stays in Drive). Returns the trip's share, which
 *  the page puts into the open trip. */
export async function setTripSync(name: string, folderIds: string[], mode?: "edit" | "view"): Promise<{ sync: TripShare | null }> {
  const me = store.me();
  const off = folderIds.map((id) => store.providerOf(id)).find((p) => !store.ready(p));
  if (off) throw new Error(off === "drive" ? "Sign in with Google first (Settings → Sync) to sync with a Google Drive folder." : store.notReady(off));
  const local = readLocal(name);
  if (!local) throw new Error("Save the trip first.");
  const s = state();
  let share = cleanShare(local.trip.sync);
  const t0 = share ? s.trips[share.id] : undefined, { mine, editable } = rights(t0, local);
  if (!share) share = { id: crypto.randomUUID(), owner: me.id, ...(me.name ? { ownerName: me.name } : {}), mode: mode === "view" ? "view" : "edit" };
  else if (mine && mode) share = { ...share, mode, ...(share.owner ? {} : { owner: me.id }) };
  const wanted = folderIds.filter((id) => s.folders.some((f) => f.id === id));
  const t = s.trips[share.id] || (s.trips[share.id] = { folders: {} });
  for (const id of Object.keys(t.folders)) if (!wanted.includes(id)) delete t.folders[id];
  for (const id of wanted) if (!t.folders[id] && editable) t.folders[id] = { fileId: "", md5: "", local: "" };
  if (!Object.keys(t.folders).length) delete s.trips[share.id];
  if (stable(cleanShare(local.trip.sync)) !== stable(share)) writeLocal(local.name, { ...local.trip, sync: share }, { keep: "spaced", fromDrive: false });
  save();
  runSync();
  return { sync: share };
}

/** A clash: keep this computer's version (it goes to Drive; Drive's is kept as a version here) or Drive's (it becomes the
 *  save; this computer's is kept as a version). */
export async function resolve(name: string, folderId: string, keep: "mine" | "theirs") {
  const local = readLocal(name), id = cleanShare(local?.trip?.sync)?.id;
  const t = id ? state().trips[id] : undefined, link = t?.folders[folderId];
  if (!local || !t || !link?.conflict) throw new Error("There's nothing to decide for this trip.");
  const fresh = await store.fileMeta(link.fileId);
  const c = await content(link.fileId, fresh.md5Checksum || "");
  const theirs = fromSharedText(c.text, local.trip, local.name);
  if (keep === "theirs") {
    const { mine } = rights(t, local);
    if (mine) theirs.sync = local.trip.sync; else { const sh = cleanShare(theirs.sync); if (sh) t.share = sh; }
    const text = writeLocal(local.name, theirs);
    link.md5 = c.md5; link.local = key(text); link.ours = false;
    setBase(link.fileId, c.text);
  } else {
    keepVersionText(SAVES_DIR, local.name, JSON.stringify(theirs));
    // Drive's version is now the starting point, so this computer's counts as the change and goes up (also when the save
    // hasn't changed since its last upload: someone saved over that one).
    link.md5 = c.md5; link.local = ""; link.ours = false;
    setBase(link.fileId, c.text);
  }
  delete link.conflict;
  save();
  await runSync();
}

/** Opens a trip from a folder: it becomes a save here (or the save it already is), synced with that folder. */
export async function openRemote(folderId: string, fileId: string): Promise<{ name: string }> {
  const s = state(), rf = s.remote[folderId]?.files.find((f) => f.id === fileId);
  if (!rf) throw new Error("That trip isn't in the folder anymore. Look again.");
  const c = await content(fileId, rf.md5);
  let data: any;
  try { data = JSON.parse(c.text); } catch { throw new Error("That file isn't a trip (it can't be read)."); }
  const inner = data?.format === FORMAT ? data.trip : data;
  // A trip file put there by hand (an export): it becomes a shared trip of the person who put it there.
  const share = cleanShare(inner?.sync) || { id: crypto.randomUUID(), owner: rf.byEmail, ...(rf.by ? { ownerName: rf.by } : {}), mode: "edit" as const };
  const have = localsById().get(share.id);
  const t = s.trips[share.id] || (s.trips[share.id] = { folders: {}, share });
  if (!t.share) t.share = share;
  if (have) {
    if (!t.folders[folderId]) { t.folders[folderId] = { fileId, md5: rf.md5, local: key(have.text) }; setBase(fileId, c.text); }
    save();
    return { name: have.name };
  }
  const name = freeName(tripName(rf.name));
  const trip = { ...fromSharedText(c.text, null, name), sync: share };
  const text = writeLocal(name, trip, { keep: false });
  t.folders[folderId] = { fileId, md5: rf.md5, local: key(text) };
  setBase(fileId, c.text);
  save();
  return { name };
}

/** The trips in the folders that aren't on this computer, with their content (for the cards). */
export function remoteTrips(): { folder: string; file: RemoteFile; trip: any }[] {
  const s = state(), locals = localsById(), seen = new Set<string>(), out: { folder: string; file: RemoteFile; trip: any }[] = [];
  // Files a save here already syncs with (a file put there by hand has no trip id of its own until it's changed).
  const here = new Set(Object.entries(s.trips).filter(([id]) => locals.has(id)).flatMap(([, t]) => Object.values(t.folders).map((l) => l.fileId)));
  for (const f of s.folders) for (const file of s.remote[f.id]?.files || []) {
    if (here.has(file.id) || (file.tripId && (locals.has(file.tripId) || seen.has(file.tripId)))) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR(), `${store.fileKey(file.id)}.json`), "utf8"));
      const data = JSON.parse(c.text), trip = data?.format === FORMAT ? data.trip : data;
      if (!trip || !Array.isArray(trip.stays)) continue;
      if (file.tripId) seen.add(file.tripId);
      out.push({ folder: f.id, file, trip });
    } catch { /* not downloaded yet, or not a trip */ }
  }
  return out;
}

export function status(): SyncStatus {
  const s = state(), acc = g.account(), locals = localsById(), trips: Record<string, TripSyncInfo> = {};
  for (const [id, t] of Object.entries(s.trips)) {
    const local = locals.get(id);
    if (!local) continue;
    const { mine, share, editable } = rights(t, local);
    trips[local.name] = {
      folders: Object.keys(t.folders), share: share || null, mine, canEdit: editable,
      conflicts: Object.entries(t.folders).filter(([, l]) => l.conflict).map(([folder, l]) => ({ folder, by: l.conflict!.by, at: l.conflict!.at })),
      ...(t.error ? { error: t.error } : {}),
    };
  }
  return {
    configured: !!g.client(), ...g.clientInfo(), ...acc, ...g.signInState(), identities: store.me().ids, editIds: store.me().ids.map(editId),
    dropbox: { configured: !!box.appKey(), keyFrom: box.keyFrom(), ...box.account(), ...box.signInState() },
    folders: s.folders, trips, running: !!current, lastRun, error: lastError, notices: s.notices,
  };
}

export function dismissNotices() { state().notices = []; save(); }

/** Who made a change, as it's stamped on the trip's parts (shared/edits.ts): the name to show, and a fingerprint of who it
 *  is rather than their account or this computer's name (the stamps go into the shared file). */
export const editId = (id: string) => crypto.createHash("sha256").update(id.trim().toLowerCase()).digest("hex").slice(0, 16);
export function editor(): { by: string; id: string } {
  const me = store.me();
  return { by: me.name, id: editId(me.id) };
}

// ---- Hooks for the saves ---------------------------------------------------------------------------------------------------
/** For the list of saves: which ones sync, and when sync last wrote into each. */
export function saveSyncInfo(): { synced: Set<string>; updated: Record<string, number> } {
  const s = state(), synced = new Set<string>();
  for (const [id, l] of localsById()) if (Object.keys(s.trips[id]?.folders || {}).length) synced.add(l.name);
  return { synced, updated: s.updated };
}

/** A page writing a trip it loaded before sync wrote a newer version from Drive into the save. When the page had the
 *  version sync replaced, its changes and Drive's are joined ("merged": the text to write instead, and the stamp the page
 *  has seen now); when they changed the same thing differently, or it's older still, it's refused ("stale": the page keeps
 *  its changes as a copy and reloads). `seen` is the page's last-known stamp (none: an older page or a rename, let through). */
export function pageWrite(name: string, seen: string | string[] | undefined, body: string): { ok: true } | { merged: string; at: number } | { stale: true; clashes: string[] } {
  const clean = cleanName(name), at = state().updated[clean] || 0;
  if (typeof seen !== "string" || at <= (Number(seen) || 0)) return { ok: true };
  const before = replaced.get(clean)?.find((r) => r.at === (Number(seen) || 0)), file = path.join(SAVES_DIR, `${clean}.json`);
  if (!before) return { stale: true, clashes: [] };
  try {
    const strip = (text: string) => { const { saveName: _n, ...t } = JSON.parse(text); return t; };
    const theirs = strip(fs.readFileSync(file, "utf8"));
    const m = mergeTrip(strip(before.text), strip(body), theirs);
    if (m.clashes.length) return { stale: true, clashes: [...new Set(m.clashes.map((p) => partOfPath(p, theirs)))] };
    return { merged: JSON.stringify({ ...(m.value as object), saveName: clean }), at };
  } catch { return { stale: true, clashes: [] }; }
}

/** The open trip, looked at often while it's on screen: when one of its files changed in Drive, a round runs (so two
 *  people working on it at the same time see each other's changes within half a minute). */
export async function checkTrip(name: string): Promise<{ changed: boolean }> {
  if (!canSync()) return { changed: false };
  const id = cleanShare(readLocal(name)?.trip?.sync)?.id, t = id ? state().trips[id] : undefined;
  if (!t) return { changed: false };
  for (const link of Object.values(t.folders)) {
    if (!link.fileId) return runSync().then(() => ({ changed: true }));
    const meta = await store.fileMeta(link.fileId).catch(() => null);
    if (meta && (meta.md5Checksum || "") !== link.md5) { await runSync(); return { changed: true }; }
  }
  return { changed: false };
}

let soon: NodeJS.Timeout | undefined;
/** A save was written: if it's a synced trip, sync in a few seconds (more saves meanwhile wait for the last). */
export function afterSave(name: string) {
  if (!canSync() || !saveSyncInfo().synced.has(cleanName(name))) return;
  clearTimeout(soon);
  soon = setTimeout(() => { runSync(); }, 4000);
  soon.unref?.();
}

/** A save is about to be deleted: when it's the trip's only save, the trip stops syncing (its file stays in Drive). */
export function beforeDelete(name: string) {
  const local = readLocal(name), id = cleanShare(local?.trip?.sync)?.id;
  const s = state(), stamped = cleanName(name) in s.updated;
  delete s.updated[cleanName(name)];
  // (Nothing to forget: no file is written, so the sync folder only appears once sync is used.)
  if (!id || !s.trips[id]) { if (stamped) save(); return; }
  let others = false;
  try { others = fs.readdirSync(SAVES_DIR).some((f) => f.endsWith(".json") && f.slice(0, -5) !== cleanName(name) && cleanShare(readLocal(f.slice(0, -5))?.trip?.sync)?.id === id); } catch { /* none */ }
  if (!others) delete s.trips[id];
  save();
}

export async function signOut() {
  await g.signOut();
  // What's synced stays set up for the next sign-in (with the same or another account).
}

let timer: NodeJS.Timeout | undefined;
/** Syncs a little after start, then every few minutes while the app runs. */
export function startSyncTimer() {
  if (timer) return;
  setTimeout(() => { runSync(); }, 15_000).unref?.();
  timer = setInterval(() => { runSync(); }, ROUND_MS);
  timer.unref?.();
}

/** For tests: read the saves again (and with `all`, the sync state too, as after a restart). */
export function resetForTests(all = false) { scan = null; if (all) { st = null; lastError = ""; } }
