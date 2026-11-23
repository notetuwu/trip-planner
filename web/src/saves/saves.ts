// Saved trips, stored as files in saves/ by the server: save, load, start a new trip, delete. Also Export / Import:
// the trip as a file to share (someone else imports it into their planner) or keep a copy of.
import type { ListSummary, PlaceList, SaveSummary } from "../../../shared/types";
import { renderBookings } from "../trip/bookings";
import { $, api, esc } from "../core/dom";
import { type AppState, save, session, setListPlaces, setState, state, tickedLists } from "../core/state";
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

const status = (msg: string) => { $("#saveStatus").textContent = msg; };
const picker = () => $<HTMLSelectElement>("#saveList");

export async function refreshSaves(select?: string) {
  try {
    const list = await api<SaveSummary[]>("/api/saves");
    picker().innerHTML = `<option value="">— Saved trips —</option>` +
      list.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} · ${new Date(s.savedAt).toLocaleDateString()}</option>`).join("");
    if (select) picker().value = select;
  } catch { status("Could not reach the server to list saves."); }
}

/** Switches to another trip and redraws everything for it. */
export async function applyState(next: Partial<AppState>) {
  setState(next);
  setListPlaces(session.listPlaces);
  fillFields();
  syncResearch();
  session.selectedDay = null; session.weather = {}; session.userMoved = false;
  save(); await refreshLists(); renderStays(); renderBookings(); renderTripTitle(); renderItinerary(); geocodeStays(); await loadList();
  geocodeItems(); loadWeather(); refreshCompanion();
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
  const data = await api<{ name: string }>("/api/saves/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify(state) });
  state.saveName = data.name; save();
  await refreshSaves(data.name);
  return data.name;
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

export function initSaves() {
  $("#exportTrip").onclick = exportTrip;
  const input = $<HTMLInputElement>("#importTrip");
  input.onchange = () => { const f = input.files?.[0]; input.value = ""; if (f) importTrip(f); };
  $("#saveBtn").onclick = async () => {
    const suggested = picker().value || state.stays.map((s) => s.city).filter(Boolean).join("-") || "My trip";
    const name = prompt("Save current inputs as:", suggested);
    if (!name) return;
    try { status(`Saved "${await saveTripAs(name)}" (includes the current itinerary, if any).`); }
    catch (e) { status((e as Error).message); }
  };
  $("#loadSave").onclick = async () => {
    const name = picker().value;
    if (!name) return status("Pick a saved trip first.");
    try {
      await applyState({ ...(await api<AppState>("/api/saves/" + encodeURIComponent(name))), saveName: name });
      save();
      status(`Loaded "${name}".`);
    } catch (e) { status((e as Error).message); }
  };
  $("#newTrip").onclick = async () => {
    if (!confirm("Start a new, empty trip? Save the current one first if you want to keep it.")) return;
    picker().value = "";
    // Start without a place list rather than defaulting to the first one; keep the model they plan with.
    await applyState({ listChosen: true, model: state.model });
    status("Started a new trip.");
  };
  $("#delSave").onclick = async () => {
    const name = picker().value;
    if (!name || !confirm(`Delete saved trip "${name}"?`)) return;
    await api("/api/saves/" + encodeURIComponent(name), { method: "DELETE" });
    await refreshSaves();
    status(`Deleted "${name}".`);
  };
}
