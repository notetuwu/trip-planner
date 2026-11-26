// Saved trips, stored as files in saves/ by the server: save, load, start a new trip, delete. Also Export / Import:
// the trip as a file to share (someone else imports it into their planner) or keep a copy of.
import type { ListSummary, PlaceList, SaveSummary, SyncStatus } from "../../../shared/types";
import { renderBookings } from "../trip/bookings";
import { $, api, apiFetch, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { isOwner, loadSyncStatus, ownerName, setSyncStatus, syncStatus } from "./sync-client";
import { ago, clearWaiting, initCollab, isMine, lastEdit, noteIncoming, noteWaiting, openHistory, renderEditChips, shared } from "./collab";
import { type Change, type Edits, changedParts, dayKey, mergeTrip, partOfPath, partsOf } from "../../../shared/edits";
import { same } from "../../../shared/merge";
import { isReadOnly, setReadOnly } from "./read-only";
import { prefs } from "../core/prefs";
import { initTrips, load as reloadTrips, openTrips } from "./trips";
import { initRecover } from "./recover";
import { type AppState, onSave, save, saveQuietly, session, setListPlaces, setState, state, tickedLists } from "../core/state";
import { geocodeStays } from "../geo/geocode";
import { geocodeItems } from "../geo/item-loc";
import { syncResearch } from "../generate/models";
import { renderItinerary } from "../itinerary/render";
import { loadWeather } from "../itinerary/weather";
import { loadList, refreshLists } from "../places/lists";
import { fillFields } from "../trip/fields";
import { renderStays } from "../trip/stays";
import { refreshCompanion } from "../trip/companion";
import { openPhotosView } from "../itinerary/photos-view";
import { refreshPhotos } from "../map/photos";
import { renderTripTitle } from "../trip/title";
import { askConfirm, askText } from "../core/ask";

/** Says how a save, load or import went: under the sidebar's buttons, and as a toast while Your trips is open. */
const status = (msg: string) => {
  $("#saveStatus").textContent = msg;
  if ($<HTMLDialogElement>("#tripsDialog").open) toast(msg);
};
const picker = () => $<HTMLSelectElement>("#saveList");

let saved: string[] = [];
/** Whether the trip on screen has changes its save doesn't have yet, and what's being done about it. */
let unsaved = false, saving = false, failed = false;
/** Saves kept in step with Drive folders, and when sync last wrote Drive's version into each (from the server's list). */
let synced = new Set<string>(), syncAt: Record<string, number> = {};
/** The newest Drive update of the open trip's save that the page has: a write from before a newer one is refused (409).
 *  Kept in the browser with the trip, so a page opened again doesn't write its older copy over one that came in while it
 *  was closed. */
const SEEN_KEY = "trip-planner-sync-seen";
let seenAt = (() => {
  try { const s = JSON.parse(localStorage.getItem(SEEN_KEY) || "null"); return s && s.name === state.saveName ? Number(s.at) || 0 : 0; } catch { return 0; }
})();
function setSeen(name: string, at: number) {
  seenAt = at;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ name, at })); } catch { /* storage blocked */ }
}
/** The open trip as its save last held it, as far as this page knows (what it last wrote there, or took from there): what
 *  changes on screen and changes that came from Drive are joined against, so neither side's are lost. Null when not known
 *  (the page was reloaded after a Drive update came in): then changes on screen are kept as a copy before Drive's come in. */
let agreed: AppState | null = null;
const withoutName = (t: AppState | null) => { if (!t) return t; const { saveName: _n, ...rest } = t; return rest; };
/** Something is being typed (a field has the focus): changes from others wait, rather than redraw the field under them. */
const typing = () => !!(document.activeElement as HTMLElement | null)?.matches?.("textarea, select, [contenteditable=''], [contenteditable='true'], input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range])");
const generating = () => !!document.querySelector<HTMLElement>("#output")?.dataset.generating;

/** Under Your trips: the save the trip on screen belongs to, and whether it's up to date. */
function showCurrent() {
  const current = state.saveName && saved.includes(state.saveName) ? state.saveName : "";
  const el = $("#currentSave");
  // A trip someone else shared as view only: shown as such, and nothing is saved into it.
  const viewOnly = !!current && state.sync?.mode === "view" && !!syncStatus && !isOwner(state.sync);
  setReadOnly(viewOnly, ownerName(state.sync), ownCopy);
  renderEditChips();
  const syncBtn = $<HTMLButtonElement>("#syncBtn"), historyBtn = $<HTMLButtonElement>("#historyBtn");
  syncBtn.hidden = !current || !synced.has(current);
  historyBtn.hidden = !state.log?.length && !shared();
  $("#tripTools").hidden = syncBtn.hidden && historyBtn.hidden;
  if (!syncBtn.disabled) syncBtn.title = `Sync now: send your changes and get everyone else's${syncStatus?.lastRun ? ` (last synced ${ago(syncStatus.lastRun)})` : ""}`;
  // On a trip several people work on: the last change, when it was someone else's.
  const last = current && shared() ? lastEdit() : undefined;
  const lastText = last && !isMine(last) ? ` · <span class="last-edit" title="${esc(new Date(last.at).toLocaleString())}">changed by ${esc(last.by)} ${esc(ago(last.at))}</span>` : "";
  if (viewOnly) { el.innerHTML = `Saved as <b>${esc(current)}</b> ${icon("cloud")} · <span class="save-state">view only</span>${lastText}`; return; }
  if (!current) { el.textContent = "This trip isn't saved yet (a copy is kept if you open another)"; el.className = "hint"; return; }
  const [text, cls] = failed ? ["couldn't be saved just now, trying again", "bad"] : saving ? ["saving…", ""] : unsaved ? [prefs.app.liveSave ? "saving in a moment" : "unsaved changes: press Save", "warn"] : ["all changes saved", "ok"];
  el.innerHTML = `Saved as <b>${esc(current)}</b>${synced.has(current) ? ` ${icon("cloud")}` : ""} · <span class="save-state ${cls}">${text}</span>${lastText}`;
}

async function listSaves() {
  const list = await api<SaveSummary[]>("/api/saves");
  synced = new Set(list.filter((s) => s.synced).map((s) => s.name));
  syncAt = Object.fromEntries(list.filter((s) => s.syncAt).map((s) => [s.name, s.syncAt!]));
  return list;
}

export async function refreshSaves(select?: string) {
  try {
    const list = await listSaves();
    picker().innerHTML = `<option value="">— Saved trips —</option>` +
      list.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} · ${new Date(s.savedAt).toLocaleDateString()}</option>`).join("");
    if (select) picker().value = select;
    $("#tripsCount").textContent = list.length ? String(list.length) : "";
    $("#tripsCount").hidden = !list.length;
    saved = list.map((s) => s.name);
    showCurrent();
  } catch { status("Could not reach the server to list saves."); }
}

/** Set while a trip is being put on screen (its own saving to the page must not count as a change to save). */
let replacing = false;
/** The next write of the open trip to its save keeps what the save held before (a trip just opened: the save may be an older version). */
let keepNext = true;

/** Switches to another trip and redraws everything for it. The trip that was on screen first gets a rescue copy (when it has
 *  changes that weren't saved), so opening, importing or starting another can't lose them. */
export async function applyState(next: Partial<AppState>, { rescue = true, changes = false }: { rescue?: boolean; changes?: boolean } = {}) {
  // (Not for a trip that's just what its save holds: opening trip after trip leaves no copies.)
  if (rescue && (unsaved || !state.saveName)) await api("/api/rescue", { method: "POST", body: JSON.stringify({ state }) }).catch(() => { /* kept if it can */ });
  replacing = true;
  try { await replace(next); } finally { replacing = false; }
  unsaved = false; failed = false; keepNext = true;
  // `changes`: the trip holds changes its save doesn't have yet (joined with ones that came in): written back in a moment.
  if (changes) changed();
  showCurrent();
}

async function replace(next: Partial<AppState>) {
  // The same trip again (changes that came in through sync, from another window, Undo in Review): the map stays where it
  // is and the day picked stays picked. Only another trip starts afresh, fitted to it.
  const sameTrip = !!next.saveName && next.saveName === state.saveName;
  setState(next);
  setListPlaces(session.listPlaces);
  fillFields();
  syncResearch();
  if (!sameTrip) { session.selectedDay = null; session.weather = {}; session.userMoved = false; }
  else if (session.selectedDay != null && session.selectedDay >= (state.itinerary?.days.length || 0)) session.selectedDay = null;
  save(); await refreshLists(); renderStays(); renderBookings(); renderTripTitle(); renderItinerary(); geocodeStays(); await loadList({ fit: !sameTrip });
  geocodeItems(); loadWeather(); refreshCompanion(); refreshPhotos(); showCurrent();
}

const FORMAT = "trip-planner-trip";
declare const __APP_VERSION__: string;

/** The trip as a file: everything on screen, minus what only matters on this computer (the prompt sent, raw thinking),
 *  plus the ticked place lists, so the planner on the other end has the same saved places to plan from. */
export async function exportTrip() {
  // Not its Drive sync: a file sent to someone is their own copy (importing it mustn't make it the synced trip).
  const { meta, sync: _sync, ...trip } = state;
  const lean = meta ? (({ prompt: _p, thinking: _t, ...m }) => m)(meta) : null;
  // Must-see places from a place list the other person doesn't have go along as kept copies.
  const kept = [...(trip.kept || [])];
  for (const p of session.listPlaces) if (trip.marks[p.title] === "must" && !kept.some((k) => k.title === p.title)) kept.push(p);
  const lists = (await Promise.all(tickedLists().map((n) => api<PlaceList>("/api/lists/" + encodeURIComponent(n)).catch(() => null))))
    .filter((l): l is PlaceList => !!l)
    .map(({ name, title, source, places }) => ({ name, title, source, places: places.map(({ title, note, url, tags, comment, address, lat, lng }) => ({ title, note, url, tags, comment, address, lat, lng })) }));
  const file = { format: FORMAT, version: __APP_VERSION__, exportedAt: new Date().toISOString(), trip: { ...trip, kept, meta: lean }, lists };
  const name = (picker().value || state.stays.map((s) => s.city).filter(Boolean).slice(0, 3).join("-") || "trip")
    .replace(/[\/:*?"<>|]+/g, "").trim().slice(0, 60) || "trip";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
  a.download = `${name}.trip.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`Exported "${a.download}". Send it to someone and they can import it.`);
}

/** Reads a trip file (an export, or a saved trip's file) into a trip and the place lists it brought, or says what's
 *  wrong with it. */
export function parseTripFile(text: string): Partial<AppState> & { bundledLists?: PlaceList[] } {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("That isn't a trip file (it can't be read)."); }
  const trip = data?.format === FORMAT ? data.trip : data; // saved trips (saves/*.json) are the bare trip
  if (!trip || typeof trip !== "object" || !Array.isArray(trip.stays)) throw new Error("That isn't a trip file (no stays in it).");
  const bundledLists = Array.isArray(data?.lists) ? data.lists.filter((l: any) => l && typeof l.name === "string" && Array.isArray(l.places)) : [];
  // An imported file is a copy of its own, not the Drive-synced trip it may have come from.
  const { sync: _sync, ...rest } = trip;
  return { ...rest, bundledLists };
}

/** Adds the lists a trip file brought that aren't here yet (a list of the same name here is kept as it is); returns
 *  the names of the trip's lists that are available now. */
async function addBundledLists(bundled: PlaceList[], wanted: string[]) {
  const have = new Set((await api<ListSummary[]>("/api/lists").catch(() => [])).map((l) => l.name));
  for (const l of bundled) {
    if (have.has(l.name)) continue;
    try { await api("/api/lists/" + encodeURIComponent(l.name), { method: "PUT", body: JSON.stringify({ title: l.title, source: l.source, places: l.places }) }); have.add(l.name); }
    catch { /* left out; its must-sees came along as kept places */ }
  }
  return wanted.filter((n) => have.has(n));
}

/** A save name from any text: letters, numbers, spaces, - and _. */
const cleanSaveName = (s: string) => s.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/** A name for the trip's save: its cities ("Osaka-Hakone-Tokyo"), with a number if that's taken by another trip. */
async function freeName(base: string) {
  const taken = new Set((await api<SaveSummary[]>("/api/saves").catch(() => [])).map((x) => x.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}
const citiesName = () => cleanSaveName(state.stays.map((s) => s.city.split(",")[0]).filter(Boolean).slice(0, 4).join("-")) || "My trip";

/** Saves the trip under `name`, remembering it as this trip's save; returns the name the server used. */
export async function saveTripAs(name: string) {
  const sameSave = state.saveName === name;
  state.saveName = name;
  // Into the save it came from: refused if Drive brought a newer version meanwhile (see putSave).
  const r = await putSave(name, JSON.stringify(state), { "X-Keep-Version": "1", ...(sameSave ? { "X-Sync-Seen": String(seenAt) } : {}) });
  if (r.syncUpdated) { unsaved = true; await takeDriveUpdate(name); throw new Error("This trip was just updated from Drive, so it was reloaded. What you had on screen is kept: Your trips → Recover."); }
  const data = r.data as { name: string; edits?: Edits | null; log?: Change[] | null };
  if (!sameSave) setSeen(data.name, syncAt[data.name] || 0);
  state.saveName = data.name;
  if (data.edits) state.edits = data.edits;
  if (data.log) state.log = data.log;
  agreed = structuredClone(state);
  document.dispatchEvent(new Event("trip-log"));
  replacing = true; save(); replacing = false;
  unsaved = false; failed = false; keepNext = false;
  await refreshSaves(data.name);
  return data.name;
}

/** Writes a save; `syncUpdated` when the server refused because Drive brought a newer version of it meanwhile. */
async function putSave(name: string, body: string, headers: Record<string, string>): Promise<{ syncUpdated?: boolean; data?: unknown }> {
  const res = await apiFetch("/api/saves/" + encodeURIComponent(name), { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data?.syncUpdated) return { syncUpdated: true };
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return { data };
}

/** Drive brought a newer version of the open trip: it comes on screen joined with the changes on screen that its save
 *  doesn't have yet (against what the save held when this page last wrote or read it). Where both changed the same thing,
 *  the one on screen stays, Drive's is kept as a copy (Your trips → Recover) and Review offers it. Without that starting
 *  point (an older page), changes on screen are kept as a copy and Drive's comes on screen, as before. A note says who
 *  changed what. */
async function takeDriveUpdate(name: string, joined = false) {
  await listSaves().catch(() => {});
  const at = syncAt[name] || 0;
  const t = await api<AppState>("/api/saves/" + encodeURIComponent(name));
  if (state.saveName !== name) return; // another trip was opened meanwhile
  const before = structuredClone(state) as AppState, clashes = new Map<string, unknown>();
  let next: AppState = t, mineLeft = false;
  const onScreen = !!agreed && !same(withoutName(state), withoutName(agreed));
  if (onScreen) {
    const m = mergeTrip(withoutName(agreed), withoutName(state), withoutName(t));
    next = m.value as AppState;
    const theirs = partsOf(t);
    for (const p of m.clashes) { const k = partOfPath(p, t); clashes.set(k, theirs[k]); }
    mineLeft = !same(withoutName(next), withoutName(t));
    // Their version of what both changed: kept, besides being offered in Review.
    if (clashes.size) await api("/api/rescue", { method: "POST", body: JSON.stringify({ state: { ...t, saveName: name } }) }).catch(() => { /* Drive keeps it too */ });
  }
  const lost = !agreed && unsaved;
  await applyState({ ...next, saveName: name }, { rescue: lost, changes: mineLeft });
  agreed = { ...t, saveName: name };
  setSeen(name, at);
  clearWaiting();
  noteIncoming(before, state, "drive", clashes);
  status(clashes.size ? `"${name}" was changed in Drive where you changed it too: yours is kept; Review shows theirs.`
    : joined || mineLeft ? `Your changes were joined with changes to "${name}" from Drive.`
      : lost ? `"${name}" was just updated from Drive. What you changed in the last moments is kept: Your trips → Recover.` : `"${name}" was updated from Drive.`);
}

/** The open trip, if it syncs, is looked at every so often: a newer version from Drive is shown (when nothing on screen is
 *  waiting to be saved; otherwise the next save finds it, see putSave). */
async function watchDrive(now = false) {
  const name = state.saveName;
  if ((!now && document.visibilityState !== "visible") || !name || !synced.has(name) || replacing || saving || generating()) return;
  // Drive is asked about this trip itself (a round runs when it changed there), so two people on it see each other's
  // changes within about half a minute.
  if (syncStatus?.folders.length) await api(`/api/sync/check?name=${encodeURIComponent(name)}`).catch(() => {});
  try { await listSaves(); } catch { return; }
  if (state.saveName !== name || replacing || saving) return;
  if ((syncAt[name] || 0) <= seenAt) { clearWaiting(); return; }
  // Without a starting point to join with, only once nothing on screen waits to be saved (the next write joins it on the
  // server, see pageWrite).
  if (!agreed && unsaved && !now) return;
  // In the middle of typing: they wait (the field isn't redrawn under the cursor), with a note and Update.
  if (!now && typing()) { noteWaiting(await whoChanged(name), () => { watchDrive(true); }); return; }
  await takeDriveUpdate(name);
}

/** Who made the newest change in the save that isn't on screen yet (for the note while it waits). */
async function whoChanged(name: string) {
  const t = await api<AppState>("/api/saves/" + encodeURIComponent(name)).catch(() => null);
  if (!t?.edits) return undefined;
  const keys = changedParts(agreed || state, t);
  return keys.map((k) => t.edits![k]).filter((e) => e && !isMine(e)).sort((a, b) => b.at - a.at)[0] || Object.values(t.edits).sort((a, b) => b.at - a.at)[0];
}

/** The Sync button by Save: what's waiting goes now, the folders are looked at now, and what others changed comes in. */
async function syncTripNow(button?: HTMLButtonElement) {
  if (button) { button.disabled = true; button.classList.add("spinning"); }
  const had = seenAt;
  try {
    if (unsaved) await writeBack(true);
    const s = await api<SyncStatus>("/api/sync/now", { method: "POST" });
    setSyncStatus(s);
    await watchDrive(true);
    const bad = s.error || s.trips[state.saveName || ""]?.error;
    toast(bad ? `Sync failed: ${bad}` : s.trips[state.saveName || ""]?.conflicts.length ? "Changed here and in a folder in ways that can't be joined: Your trips shows which to keep" : seenAt !== had ? "Synced: others' changes are in" : unsaved ? "Synced (your latest changes go in a moment)" : "Synced: up to date");
  } catch (e) { toast(`Sync failed: ${(e as Error).message}`); }
  finally { if (button) { button.disabled = false; button.classList.remove("spinning"); } showCurrent(); }
}

/** A trip someone shared as view only, as a trip of their own: a new save, not synced, to change as they like. */
async function ownCopy() {
  const base = state.saveName || citiesName();
  const name = await freeName(cleanSaveName(`${base} my copy`));
  delete state.sync;
  try { status(`Saved your own copy as "${await saveTripAs(name)}". Change it as you like; the shared one stays as it was.`); }
  catch (e) { status((e as Error).message); }
}

// ---- Keeping the open trip's save up to date by itself ----
let timer: number | undefined;
/** Writes the trip on screen into its save (not for a trip that has none: those get a copy when replaced). */
async function writeBack(now = false) {
  clearTimeout(timer);
  const name = state.saveName;
  if ((!prefs.app.liveSave && !now) || !name || !saved.includes(name) || replacing || isReadOnly()) return;
  // A plan being made: the trip is half changed; the end of it saves.
  if (document.querySelector<HTMLElement>("#output")?.dataset.generating) { timer = window.setTimeout(writeBack, 5000); return; }
  // Another window has changed the trip since this one last looked (this copy is out of date, e.g. a tab left open from earlier):
  // it doesn't write. It takes the newer copy when it's looked at again.
  const here = Number(localStorage.getItem("trip-planner-v2-at")) || 0;
  const newer = await api<{ at: number }>(`/api/current?since=${here}`).then((r) => r.at > here, () => false);
  if (newer) { timer = window.setTimeout(writeBack, 30000); return; }
  saving = true; showCurrent();
  try {
    const body = JSON.stringify(state);
    const r = await putSave(name, body, { ...(keepNext ? { "X-Keep-Version": "1" } : {}), "X-Sync-Seen": String(seenAt) });
    // Drive brought a version the server couldn't join this one with: it's joined here (nothing on screen is lost), then
    // written. Not under the cursor: while typing it waits, with a note.
    if (r.syncUpdated) {
      saving = false;
      if (typing() && !now) { noteWaiting(await whoChanged(name), () => { watchDrive(true); }); timer = window.setTimeout(writeBack, 15000); }
      else await takeDriveUpdate(name);
      return;
    }
    keepNext = false; failed = false;
    // Changed again while it was being written: another write follows.
    unsaved = JSON.stringify(state) !== body;
    // What the save holds now, as far as this page's changes go (and who changed what, from the server).
    const data = r.data as { merged?: boolean; edits?: Edits | null; log?: Change[] | null };
    agreed = { ...JSON.parse(body), ...(data?.edits ? { edits: data.edits } : {}), ...(data?.log ? { log: data.log } : {}) };
    if (data?.edits || data?.log) { if (data.edits) state.edits = data.edits; if (data.log) state.log = data.log; saveQuietly(); document.dispatchEvent(new Event("trip-log")); }
    // Joined with changes that came from Drive meanwhile: the result comes on screen (not while typing: then the next write
    // is joined the same way, and it comes in once they stop).
    if (data?.merged) {
      saving = false;
      if (!typing() || now) await takeDriveUpdate(name, true);
      else { noteWaiting(await whoChanged(name), () => { watchDrive(true); }); if (unsaved) timer = window.setTimeout(writeBack, 3000); }
      return;
    }
    if (unsaved) timer = window.setTimeout(writeBack, 3000);
  } catch { failed = true; timer = window.setTimeout(writeBack, 20000); }
  finally { saving = false; showCurrent(); }
}

/** Every change to the trip on screen: marks it unsaved and writes it back a few seconds later. */
function changed() {
  if (replacing) return;
  unsaved = true; showCurrent();
  if (!prefs.app.liveSave || !state.saveName) return;
  clearTimeout(timer);
  timer = window.setTimeout(writeBack, 4000);
}

/** Saves the trip by itself (Settings → General): into its own save if it has one, else under a new free name. */
export async function saveByItself() {
  try { return await saveTripAs(state.saveName || await freeName(citiesName())); } catch { return null; }
}

/** On start with "a new trip" (Settings → General): keeps the trip that was open in Saved trips, then starts fresh.
 *  Only once per session, so reloading the page doesn't throw away what you're working on. */
export async function startFresh() {
  if (sessionStorage.getItem("trip-planner-started")) return;
  sessionStorage.setItem("trip-planner-started", "1");
  const worked = state.itinerary || state.stays.some((s) => s.city);
  if (worked && !(await saveByItself())) return; // couldn't keep it: leave it open rather than lose it
  const model = state.model;
  picker().value = "";
  await applyState({ listChosen: true, model });
  status(worked ? "Started a new trip; the last one is in Saved trips." : "Started a new trip.");
}

export async function importTrip(file: File) {
  try {
    const { bundledLists = [], ...trip } = parseTripFile(await file.text());
    const what = trip.stays?.map((s) => s.city).filter(Boolean).join(", ") || "an empty trip";
    if (!await askConfirm({ title: `Open “${file.name}”?`, text: `${what}. It's added to your saved trips and replaces the trip on screen (that one is kept as a copy if it has changes that weren't saved).`, ok: "Open it" })) return;
    picker().value = "";
    // Their place lists come along in the file: add the missing ones here and keep them ticked (files from before
    // that start without lists; their must-sees came along as kept places).
    const lists = await addBundledLists(bundledLists, trip.lists || (trip.list ? [trip.list] : []));
    await applyState({ ...trip, list: lists[0] || "", lists, listChosen: true });
    // Keep it in the saved trips right away, named after the file (with a number if that name is taken).
    const name = await freeName(cleanSaveName(file.name.replace(/(\.trip)?\.json$/i, "")) || "Imported trip");
    try { status(`Imported "${file.name}" and saved it as "${await saveTripAs(name)}".`); }
    catch { status(`Imported "${file.name}", but it couldn't be saved; use Save to keep it.`); }
  } catch (e) { status((e as Error).message); }
}

/** Opens a saved trip in place of the one on screen. */
export async function openSave(name: string) {
  // What the page has seen of Drive's updates to this save: looked up before the trip is read, so one that comes in between
  // isn't taken as seen.
  await listSaves().catch(() => {});
  const at = syncAt[name] || 0;
  const t = await api<AppState>("/api/saves/" + encodeURIComponent(name));
  await applyState({ ...t, saveName: name });
  agreed = { ...t, saveName: name };
  setSeen(name, at);
  save();
  await refreshSaves(name);
  status(`Opened "${name}".`);
}

/** Opens one of the copies of a trip that was replaced; it goes back into its own save in a moment (the save as it is now is kept). */
export async function restoreCopy(id: string) {
  const t = await api<AppState>(`/api/rescue/${id}`);
  const what = (t.stays || []).map((s) => s.city?.split(",")[0]).filter(Boolean).slice(0, 3).join(", ") || "an empty trip";
  if (!await askConfirm({ title: "Open this copy?", text: `${what}. It replaces the trip on screen; a copy of that is kept first.`, ok: "Open it" })) return false;
  await applyState({ ...t });
  // Its changes are the ones that were lost: they go back into its save.
  unsaved = true; showCurrent();
  if (prefs.app.liveSave && state.saveName && saved.includes(state.saveName)) { clearTimeout(timer); timer = window.setTimeout(writeBack, 1500); }
  status(`Opened the copy${t.saveName ? ` of "${t.saveName}"` : ""}.${t.saveName ? "" : " Save it to keep it."}`);
  return true;
}

/** Goes back to an earlier version of a saved trip: it becomes the open trip and the save, and the save as it is now is kept as a version. */
export async function restoreVersion(name: string, id: string) {
  const t = await api<AppState>(`/api/saves/${encodeURIComponent(name)}/history/${id}`);
  if (!await askConfirm({ title: `Go back to this version of “${name}”?`, text: "The version saved now is kept too, so you can come back.", ok: "Go back" })) return false;
  await applyState({ ...t, saveName: name });
  await saveTripAs(name);
  status(`"${name}" is back to the earlier version.`);
  return true;
}

/** Why a name can't be used for a new save ("" when it can): it's empty, or another trip has it. */
export async function nameProblem(): Promise<(v: string) => string> {
  const taken = new Set((await api<SaveSummary[]>("/api/saves").catch(() => [])).map((x) => x.name.toLowerCase()));
  return (v) => { const n = cleanSaveName(v); return !n ? "Use letters or numbers." : taken.has(n.toLowerCase()) ? `There's already a trip called “${n}”.` : ""; };
}

/** Save: the trip on screen goes into its own save (no questions). A trip that has none yet (started before trips had a
 *  name, or after an import that couldn't be saved) is given one first. Copies under another name: Browse trips → Make a
 *  copy. */
async function saveCurrent() {
  if (isReadOnly()) { status("This trip is view only. Make your own copy to change and save it."); return; }
  if (state.saveName && saved.includes(state.saveName)) {
    try { await saveTripAs(state.saveName); status(`Saved "${state.saveName}".`); toast("Saved"); }
    catch (e) { status((e as Error).message); }
    return;
  }
  const name = await askText({ title: "Name this trip", label: "Name", value: citiesName(), ok: "Save", required: true, validate: await nameProblem() });
  if (!name) return;
  try { status(`Saved "${await saveTripAs(cleanSaveName(name))}".`); }
  catch (e) { status((e as Error).message); }
}

/** New trip: asks for its name (one no other trip has), starts it empty and saves it under that name straight away. */
async function newTrip() {
  const name = await askText({
    title: "New trip", label: "Name", placeholder: "e.g. Japan in spring", ok: "Create", required: true, validate: await nameProblem(),
    text: state.saveName ? "An empty trip. The one on screen stays in your trips." : "An empty trip. The one on screen isn't saved: a copy is kept (Your trips → Recover).",
  });
  if (!name) return false;
  picker().value = "";
  // Start without a place list rather than defaulting to the first one; keep the model they plan with.
  await applyState({ listChosen: true, model: state.model });
  try { status(`Started "${await saveTripAs(cleanSaveName(name))}".`); }
  catch (e) { status(`Started a new trip, but it couldn't be saved: ${(e as Error).message}`); }
  return true;
}

/** A change from Review (Undo, Use theirs): on screen, and saved in a moment. */
async function applyChange(next: AppState) {
  await applyState(next, { rescue: false, changes: true });
}

/** Brings a part of the trip into view (from Review's Show). */
function showPart(key: string) {
  const flash = (el: Element | null) => {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("collab-flash"); void (el as HTMLElement).offsetWidth; el.classList.add("collab-flash");
  };
  if (key.startsWith("day:")) {
    const days = state.itinerary?.days || [], i = days.findIndex((_d, j) => dayKey(days, j) === key);
    if (i >= 0) { session.foldedStays.clear(); renderItinerary(); flash(document.getElementById(`day-${i}`)); }
    return;
  }
  if (key.startsWith("photo:")) { openPhotosView("place", key.slice(6)); return; }
  if (key === "ideas") { $<HTMLDetailsElement>("#ideasFold").open = true; flash($("#ideasFold")); return; }
  if (key === "details") { flash($("#travelers").closest(".row")); return; }
  const at: Record<string, string> = { stays: "#stays", bookings: "#bookings", places: "#placesSummary", plan: "#output" };
  if (at[key]) flash(document.querySelector(at[key]));
}

export function initSaves() {
  onSave(changed);
  // A page opened again with a trip that has a save: changes made just before it was closed may not have been written yet, so
  // it counts as unsaved until it's written back (an out-of-date copy is never written: see writeBack).
  if (state.saveName) { unsaved = true; timer = window.setTimeout(writeBack, 6000); }
  // The page going to the background (a tab left, a window minimised) writes what's waiting at once.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && unsaved) writeBack(); else if (document.visibilityState === "visible") watchDrive(); });
  // A synced trip that's open: Drive's newer versions come in (the server looks at Drive every few minutes).
  window.setInterval(watchDrive, 15000);
  // The page was reloaded with a save open: what it has is what the save holds now. When Drive hasn't brought anything into
  // the save since this page last saw it, the save is what changes on screen are joined against.
  if (state.saveName) {
    const name = state.saveName;
    listSaves().then(async () => {
      showCurrent();
      if ((syncAt[name] || 0) > seenAt) return;
      const t = await api<AppState>("/api/saves/" + encodeURIComponent(name)).catch(() => null);
      if (t && !agreed && state.saveName === name) agreed = { ...t, saveName: name };
    }, () => {});
  }
  initCollab({ apply: applyChange, show: showPart, sync: syncTripNow, canSync: () => !!state.saveName && synced.has(state.saveName) });
  $<HTMLButtonElement>("#syncBtn").onclick = (e) => syncTripNow(e.currentTarget as HTMLButtonElement);
  $<HTMLButtonElement>("#historyBtn").onclick = openHistory;
  loadSyncStatus().then(showCurrent);
  $("#exportTrip").onclick = exportTrip;
  const input = $<HTMLInputElement>("#importTrip");
  input.onchange = () => { const f = input.files?.[0]; input.value = ""; if (f) importTrip(f); };
  $("#saveBtn").onclick = saveCurrent;
  $("#newTrip").onclick = newTrip;
  $("#openTrips").onclick = openTrips;
  initRecover({ copy: restoreCopy, version: restoreVersion });
  // The same from Your trips, which then shows the change.
  const trips = $<HTMLDialogElement>("#tripsDialog");
  $("#tripsNew").onclick = async () => { if (await newTrip()) trips.close(); };
  $("#tripsSave").onclick = async () => { await saveCurrent(); reloadTrips(); };
  const input2 = $<HTMLInputElement>("#tripsImport");
  input2.onchange = async () => { const f = input2.files?.[0]; input2.value = ""; if (f) { await importTrip(f); reloadTrips(); } };
  initTrips({ open: openSave, afterChange: async (renamed) => { await refreshSaves(renamed?.to ?? (picker().value || undefined)); } });
}
