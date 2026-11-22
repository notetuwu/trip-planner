// Saved trips, stored as files in saves/ by the server: save, load, start a new trip, delete. Also Export / Import:
// the trip as a file to share (someone else imports it into their planner) or keep a copy of.
import type { SaveSummary } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { type AppState, save, session, setListPlaces, setState, state } from "../core/state";
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
  save(); await refreshLists(); renderStays(); renderTripTitle(); renderItinerary(); geocodeStays(); await loadList();
  geocodeItems(); loadWeather(); refreshCompanion();
}

const FORMAT = "trip-planner-trip";
declare const __APP_VERSION__: string;

/** The trip as a file: everything on screen, minus what only matters on this computer (the prompt sent, raw thinking). */
export function exportTrip() {
  const { meta, ...trip } = state;
  const lean = meta ? (({ prompt: _p, thinking: _t, ...m }) => m)(meta) : null;
  // Must-see places from a place list the other person doesn't have go along as kept copies.
  const kept = [...(trip.kept || [])];
  for (const p of session.listPlaces) if (trip.marks[p.title] === "must" && !kept.some((k) => k.title === p.title)) kept.push(p);
  const file = { format: FORMAT, version: __APP_VERSION__, exportedAt: new Date().toISOString(), trip: { ...trip, kept, meta: lean } };
  const name = (picker().value || state.stays.map((s) => s.city).filter(Boolean).slice(0, 3).join("-") || "trip")
    .replace(/[\/:*?"<>|]+/g, "").trim().slice(0, 60) || "trip";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
  a.download = `${name}.trip.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`Exported "${a.download}". Send it to someone and they can import it.`);
}

/** Reads a trip file (an export, or a saved trip's file) into a trip, or says what's wrong with it. */
export function parseTripFile(text: string): Partial<AppState> {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error("That isn't a trip file (it can't be read)."); }
  const trip = data?.format === FORMAT ? data.trip : data; // saved trips (saves/*.json) are the bare trip
  if (!trip || typeof trip !== "object" || !Array.isArray(trip.stays)) throw new Error("That isn't a trip file (no stays in it).");
  return trip;
}

export async function importTrip(file: File) {
  try {
    const trip = parseTripFile(await file.text());
    const what = trip.stays?.map((s) => s.city).filter(Boolean).join(", ") || "an empty trip";
    if (!confirm(`Open the trip in "${file.name}" (${what})? It replaces the trip on screen; save that first if you want to keep it.`)) return;
    picker().value = "";
    // Their place list isn't here: start without one (their must-sees came along in the file).
    await applyState({ ...trip, list: "", listChosen: true });
    status(`Imported "${file.name}". Save it to keep it in your saved trips.`);
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
    try {
      const data = await api<{ name: string }>("/api/saves/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify(state) });
      await refreshSaves(data.name);
      status(`Saved "${data.name}" (includes the current itinerary, if any).`);
    } catch (e) { status((e as Error).message); }
  };
  $("#loadSave").onclick = async () => {
    const name = picker().value;
    if (!name) return status("Pick a saved trip first.");
    try {
      await applyState(await api<AppState>("/api/saves/" + encodeURIComponent(name)));
      status(`Loaded "${name}".`);
    } catch (e) { status((e as Error).message); }
  };
  $("#newTrip").onclick = async () => {
    if (!confirm("Start a new, empty trip? Save the current one first if you want to keep it.")) return;
    picker().value = "";
    await applyState({ listChosen: true }); // start without a place list rather than defaulting to the first one
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
