// Place lists from the server: tick one or more (their places are all considered for the plan), import from Google
// Maps or a CSV, re-sync, remove.
import type { ListSummary, Place, PlaceList } from "../../../shared/types";
import { $, $$, api, esc } from "../core/dom";
import { ago } from "../core/format";
import { icon } from "../core/icons";
import { save, session, setListPlaces, setTickedLists, state, tickedLists } from "../core/state";
import { geocodePlaces } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { renderChips } from "./chips";

const status = (msg: string) => { $("#importStatus").textContent = msg; };
const metaOf = (name: string) => session.lists.find((l) => l.name === name);
const sourceText = (m: ListSummary) => m.source?.type === "google" ? `Google Maps · synced ${ago(m.syncedAt)}` : m.source?.type === "csv" ? "CSV file" : "Uploaded CSV";
/** Which lists are syncing right now, with what happened last. */
const syncing = new Set<string>(), syncNote = new Map<string, string>();

export async function refreshLists() {
  try { session.lists = await api<ListSummary[]>("/api/lists"); }
  catch { $("#counts").textContent = `Can't reach the server. Start it with "python start.py" and open http://localhost:5173`; return; }
  // Older saves had no list; tick the first one unless the user chose none.
  if (!tickedLists().length && !state.listChosen && session.lists.length) setTickedLists([session.lists[0].name]);
  // Lists that were removed meanwhile drop out.
  const known = tickedLists().filter((n) => metaOf(n));
  if (known.length !== tickedLists().length) setTickedLists(known);
  renderPicker();
}

/** The lists as a checklist: tick the ones to plan with; each can be synced (Google, CSV) or removed. */
function renderPicker() {
  const on = new Set(tickedLists());
  const el = $("#listPicker");
  el.innerHTML = session.lists.length ? session.lists.map((l) => `
    <div class="list-row${on.has(l.name) ? " on" : ""}">
      <label><input type="checkbox" data-list="${esc(l.name)}" ${on.has(l.name) ? "checked" : ""}>
        <span class="list-name">${esc(l.name)} <span class="hint">${l.count}</span></span>
        <span class="hint list-src">${esc(syncing.has(l.name) ? "Syncing…" : syncNote.get(l.name) || sourceText(l))}</span></label>
      ${["google", "csv"].includes(l.source?.type || "") ? `<button type="button" class="icon-btn" data-sync="${esc(l.name)}" title="Re-import this list from its source" ${syncing.has(l.name) ? "disabled" : ""}>${icon("refresh")}</button>` : ""}
      <button type="button" class="icon-btn" data-del="${esc(l.name)}" title="Remove this list">${icon("trash")}</button>
    </div>`).join("")
    : `<p class="hint">No place lists yet. Import one below: mark everything interesting in Google Maps, save it to a list, and paste the list's share link.</p>`;
  const n = on.size;
  $("#listMeta").textContent = n > 1 ? `${n} lists` : "";
  $$<HTMLInputElement>("[data-list]", el).forEach((b) => {
    b.onchange = () => {
      const names = session.lists.map((l) => l.name).filter((x) => (x === b.dataset.list ? b.checked : on.has(x)));
      setTickedLists(names); save(); renderPicker(); loadList();
    };
  });
  $$<HTMLButtonElement>("[data-sync]", el).forEach((b) => { b.onclick = () => syncList(b.dataset.sync!, false); });
  $$<HTMLButtonElement>("[data-del]", el).forEach((b) => { b.onclick = () => removeList(b.dataset.del!); });
}

/** A place on several ticked lists counts once (the first list's copy). */
function merge(lists: Place[][]) {
  const seen = new Set<string>(), out: Place[] = [];
  for (const p of lists.flat()) {
    const key = p.title.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

let loading = 0;
/** Loads the places of every ticked list. Google lists re-sync quietly when they're more than an hour old. */
export async function loadList({ autoSync = true } = {}) {
  const names = tickedLists().filter((n) => metaOf(n));
  const mine = ++loading;
  if (!names.length) { setListPlaces([]); renderChips(); drawMap({ fit: true }); return; }
  try {
    const lists = await Promise.all(names.map((n) => api<PlaceList>("/api/lists/" + encodeURIComponent(n))));
    if (mine !== loading) return; // ticked something else meanwhile
    setListPlaces(merge(lists.map((l) => l.places)));
    renderChips(); renderItinerary(); drawMap({ fit: true }); geocodePlaces();
    if (autoSync) for (const l of lists) if (l.source?.type === "google" && Date.now() - +new Date(l.syncedAt || 0) > 3600e3) syncList(l.name, true);
  } catch (e) { $("#counts").textContent = (e as Error).message; }
}

async function syncList(name: string, quiet: boolean) {
  if (syncing.has(name)) return;
  syncing.add(name); syncNote.delete(name); renderPicker();
  try {
    const list = await api<PlaceList>(`/api/lists/${encodeURIComponent(name)}/sync`, { method: "POST" });
    const before = metaOf(name)?.count;
    syncing.delete(name);
    await refreshLists();
    await loadList({ autoSync: false });
    if (!quiet || before !== list.places.length) status(`Synced "${name}": ${list.places.length} places.`);
  } catch (e) {
    syncing.delete(name);
    syncNote.set(name, `Sync failed: ${(e as Error).message}`);
    renderPicker();
  }
}

async function removeList(name: string) {
  const m = metaOf(name);
  if (!m || !confirm(`Remove the place list "${name}"?${m.source?.type === "csv" ? "\n(The CSV file stays; it is re-added on next server start.)" : ""}`)) return;
  await api("/api/lists/" + encodeURIComponent(name), { method: "DELETE" });
  setTickedLists(tickedLists().filter((n) => n !== name)); save();
  await refreshLists(); loadList();
}

/** A newly imported list is ticked, next to the ones already ticked. */
async function useImported(list: PlaceList, autoSync: boolean) {
  setTickedLists([...tickedLists(), list.name]); save();
  await refreshLists(); await loadList({ autoSync });
  status(`Imported "${list.name}" (${list.places.length} places). Its places are considered for the plan along with any other ticked lists.`);
}

export function initLists() {
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
