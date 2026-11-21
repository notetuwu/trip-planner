// Saved trips, stored as files in saves/ by the server: save, load, start a new trip, delete.
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
  geocodeItems(); loadWeather();
}

export function initSaves() {
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
