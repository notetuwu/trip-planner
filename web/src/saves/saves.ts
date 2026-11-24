// Saved trips, stored as files in saves/ by the server: save, load, start a new trip, delete. Also Export / Import:
// the trip as a file to share (someone else imports it into their planner) or keep a copy of.
import type { ListSummary, PlaceList, SaveSummary } from "../../../shared/types";
import { renderBookings } from "../trip/bookings";
import { $, api, esc, toast } from "../core/dom";
import { prefs } from "../core/prefs";
import { initTrips, load as reloadTrips, openTrips } from "./trips";
import { initRecover } from "./recover";
import { type AppState, onSave, save, session, setListPlaces, setState, state, tickedLists } from "../core/state";
import { geocodeStays } from "../geo/geocode";
import { geocodeItems } from "../geo/item-loc";
import { syncResearch } from "../generate/models";
import { renderItinerary } from "../itinerary/render";
import { loadWeather } from "../itinerary/weather";
import { loadList, refreshLists } from "../places/lists";
import { fillFields } from "../trip/fields";
import { renderStays } from "../trip/stays";
import { refreshCompanion } from "../trip/companion";
import { renderTripTitle } from "../trip/title";

/** Says how a save, load or import went: under the sidebar's buttons, and as a toast while Your trips is open. */
const status = (msg: string) => {
  $("#saveStatus").textContent = msg;
  if ($<HTMLDialogElement>("#tripsDialog").open) toast(msg);
};
const picker = () => $<HTMLSelectElement>("#saveList");

let saved: string[] = [];
/** Whether the trip on screen has changes its save doesn't have yet, and what's being done about it. */
let unsaved = false, saving = false, failed = false;
/** Under Your trips: the save the trip on screen belongs to, and whether it's up to date. */
function showCurrent() {
  const current = state.saveName && saved.includes(state.saveName) ? state.saveName : "";
  const el = $("#currentSave");
  if (!current) { el.textContent = "This trip isn't saved yet (a copy is kept if you open another)"; el.className = "hint"; return; }
  const [text, cls] = failed ? ["couldn't be saved just now, trying again", "bad"] : saving ? ["saving…", ""] : unsaved ? [prefs.app.liveSave ? "saving in a moment" : "unsaved changes: press Save", "warn"] : ["all changes saved", "ok"];
  el.innerHTML = `Saved as <b>${esc(current)}</b> · <span class="save-state ${cls}">${text}</span>`;
}

export async function refreshSaves(select?: string) {
  try {
    const list = await api<SaveSummary[]>("/api/saves");
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
export async function applyState(next: Partial<AppState>, { rescue = true }: { rescue?: boolean } = {}) {
  // (Not for a trip that's just what its save holds: opening trip after trip leaves no copies.)
  if (rescue && (unsaved || !state.saveName)) await api("/api/rescue", { method: "POST", body: JSON.stringify({ state }) }).catch(() => { /* kept if it can */ });
  replacing = true;
  try { await replace(next); } finally { replacing = false; }
  unsaved = false; failed = false; keepNext = true;
  showCurrent();
}

async function replace(next: Partial<AppState>) {
  setState(next);
  setListPlaces(session.listPlaces);
  fillFields();
  syncResearch();
  session.selectedDay = null; session.weather = {}; session.userMoved = false;
  save(); await refreshLists(); renderStays(); renderBookings(); renderTripTitle(); renderItinerary(); geocodeStays(); await loadList();
  geocodeItems(); loadWeather(); refreshCompanion(); showCurrent();
}

const FORMAT = "trip-planner-trip";
declare const __APP_VERSION__: string;

/** The trip as a file: everything on screen, minus what only matters on this computer (the prompt sent, raw thinking),
 *  plus the ticked place lists, so the planner on the other end has the same saved places to plan from. */
export async function exportTrip() {
  const { meta, ...trip } = state;
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
  return { ...trip, bundledLists };
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
  state.saveName = name;
  const data = await api<{ name: string }>("/api/saves/" + encodeURIComponent(name), { method: "PUT", headers: { "X-Keep-Version": "1" }, body: JSON.stringify(state) });
  state.saveName = data.name;
  replacing = true; save(); replacing = false;
  unsaved = false; failed = false; keepNext = false;
  await refreshSaves(data.name);
  return data.name;
}

// ---- Keeping the open trip's save up to date by itself ----
let timer: number | undefined;
/** Writes the trip on screen into its save (not for a trip that has none: those get a copy when replaced). */
async function writeBack() {
  clearTimeout(timer);
  const name = state.saveName;
  if (!prefs.app.liveSave || !name || !saved.includes(name) || replacing) return;
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
    await api("/api/saves/" + encodeURIComponent(name), { method: "PUT", ...(keepNext ? { headers: { "X-Keep-Version": "1" } } : {}), body });
    keepNext = false; failed = false;
    // Changed again while it was being written: another write follows.
    unsaved = JSON.stringify(state) !== body;
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
    if (!confirm(`Open the trip in "${file.name}" (${what})? It's added to your saved trips and replaces the trip on screen; save that first if you want to keep it.`)) return;
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
  await applyState({ ...(await api<AppState>("/api/saves/" + encodeURIComponent(name))), saveName: name });
  save();
  await refreshSaves(name);
  status(`Opened "${name}".`);
}

/** Opens one of the copies of a trip that was replaced; it goes back into its own save in a moment (the save as it is now is kept). */
export async function restoreCopy(id: string) {
  const t = await api<AppState>(`/api/rescue/${id}`);
  const what = (t.stays || []).map((s) => s.city?.split(",")[0]).filter(Boolean).slice(0, 3).join(", ") || "an empty trip";
  if (!confirm(`Open this copy (${what})? It replaces the trip on screen; a copy of that is kept first.`)) return false;
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
  if (!confirm(`Go back to this version of "${name}"? The version saved now is kept too, so you can come back.`)) return false;
  await applyState({ ...t, saveName: name });
  await saveTripAs(name);
  status(`"${name}" is back to the earlier version.`);
  return true;
}

async function saveCurrent() {
  const suggested = state.saveName || picker().value || state.stays.map((s) => s.city).filter(Boolean).join("-") || "My trip";
  const name = prompt("Save this trip as:", suggested);
  if (!name) return;
  try { status(`Saved "${await saveTripAs(name)}" (with its itinerary, if there is one).`); }
  catch (e) { status((e as Error).message); }
}

async function newTrip() {
  if (!confirm("Start a new, empty trip? Save the current one first if you want to keep it.")) return false;
  picker().value = "";
  // Start without a place list rather than defaulting to the first one; keep the model they plan with.
  await applyState({ listChosen: true, model: state.model });
  status("Started a new trip.");
  return true;
}

export function initSaves() {
  onSave(changed);
  // A page opened again with a trip that has a save: changes made just before it was closed may not have been written yet, so
  // it counts as unsaved until it's written back (an out-of-date copy is never written: see writeBack).
  if (state.saveName) { unsaved = true; timer = window.setTimeout(writeBack, 6000); }
  // The page going to the background (a tab left, a window minimised) writes what's waiting at once.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && unsaved) writeBack(); });
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
