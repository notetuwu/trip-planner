// Place lists from the server: pick one, import from Google Maps or a CSV, re-sync, delete.
import type { ListSummary, PlaceList } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { ago } from "../core/format";
import { save, session, setListPlaces, state } from "../core/state";
import { geocodePlaces } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { renderChips } from "./chips";

const listMeta = () => session.lists.find((l) => l.name === state.list);
const status = (msg: string) => { $("#importStatus").textContent = msg; };

export async function refreshLists() {
  try { session.lists = await api<ListSummary[]>("/api/lists"); }
  catch { $("#counts").textContent = `Can't reach the server. Start it with "python start.py" and open http://localhost:5173`; return; }
  // Older saves had no list; use the first one unless the user chose "No place list".
  if (!state.list && !state.listChosen && session.lists.length) state.list = session.lists[0].name;
  if (state.list && !listMeta()) state.list = session.lists[0]?.name || "";
  $("#listSelect").innerHTML = `<option value="">No place list</option>` +
    session.lists.map((l) => `<option value="${esc(l.name)}">${esc(l.name)} (${l.count})</option>`).join("");
  $<HTMLSelectElement>("#listSelect").value = state.list;
}

function renderListMeta() {
  const m = listMeta();
  $("#syncList").hidden = !m || !["google", "csv"].includes(m.source?.type || "");
  $("#delList").hidden = !m;
  $("#listMeta").textContent = !m ? "" : m.source?.type === "google" ? `Google Maps · synced ${ago(m.syncedAt)}` : m.source?.type === "csv" ? "CSV file" : "Uploaded CSV";
}

export async function loadList({ autoSync = true } = {}) {
  const meta = listMeta();
  renderListMeta();
  if (!meta) { setListPlaces([]); renderChips(); drawMap({ fit: true }); return; }
  try {
    const list = await api<PlaceList>("/api/lists/" + encodeURIComponent(meta.name));
    setListPlaces(list.places);
    renderChips(); renderItinerary(); drawMap({ fit: true }); geocodePlaces();
    // Google lists re-sync quietly when they're more than an hour old.
    if (autoSync && list.source?.type === "google" && Date.now() - +new Date(list.syncedAt || 0) > 3600e3) syncList(true);
  } catch (e) { $("#counts").textContent = (e as Error).message; }
}

async function syncList(quiet: boolean) {
  const m = listMeta(); if (!m) return;
  if (!quiet) $("#listMeta").textContent = "Syncing…";
  try {
    const list = await api<PlaceList>(`/api/lists/${encodeURIComponent(m.name)}/sync`, { method: "POST" });
    const before = session.places.length;
    setListPlaces(list.places);
    await refreshLists();
    renderListMeta(); renderChips(); drawMap(); geocodePlaces();
    if (!quiet || before !== session.places.length) status(`Synced "${m.name}": ${session.places.length} places.`);
  } catch (e) { $("#listMeta").textContent = `Sync failed: ${(e as Error).message}`; }
}

async function useImported(list: PlaceList, autoSync: boolean) {
  state.list = list.name; state.listChosen = true; save();
  await refreshLists(); await loadList({ autoSync });
  status(`Imported "${list.name}" — ${list.places.length} places.`);
}

export function initLists() {
  $<HTMLSelectElement>("#listSelect").onchange = (e) => {
    state.list = (e.target as HTMLSelectElement).value; state.listChosen = true; save(); loadList();
  };
  $("#syncList").onclick = () => syncList(false);
  $("#delList").onclick = async () => {
    const m = listMeta();
    if (!m || !confirm(`Remove the place list "${m.name}"?${m.source?.type === "csv" ? "\n(The CSV file stays; it is re-added on next server start.)" : ""}`)) return;
    await api("/api/lists/" + encodeURIComponent(m.name), { method: "DELETE" });
    state.list = ""; save(); await refreshLists(); loadList();
  };
  $("#gmImport").onclick = async () => {
    const input = $<HTMLInputElement>("#gmUrl"), btn = $<HTMLButtonElement>("#gmImport");
    const url = input.value.trim();
    if (!url) return;
    btn.disabled = true; status("Importing from Google Maps…");
    try {
      await useImported(await api<PlaceList>("/api/lists/import", { method: "POST", body: JSON.stringify({ url }) }), false);
      input.value = "";
    } catch (e) { status((e as Error).message); }
    finally { btn.disabled = false; }
  };
  $<HTMLInputElement>("#csvFile").onchange = async (e) => {
    const el = e.target as HTMLInputElement, file = el.files?.[0]; if (!file) return;
    const name = prompt("Name for this place list:", file.name.replace(/\.csv$/i, ""));
    el.value = "";
    if (!name) return;
    try {
      await useImported(await api<PlaceList>("/api/lists/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify({ csv: await file.text() }) }), true);
    } catch (err) { status((err as Error).message); }
  };
}
