// Place lists from the server (in the Places dialog): tick lists to show their places on the map, and per list whether
// the planner may pick from its places as suggestions (else only the starred ones go); import from Google Maps or a CSV
// (in a dialog), re-sync, remove.
import type { ListSummary, Place, PlaceList } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { ago } from "../core/format";
import { icon } from "../core/icons";
import { listSuggest, save, session, setListPlaces, setTickedLists, state, tickedLists } from "../core/state";
import { geocodePlaces } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { renderChips } from "./chips";
import { askConfirm } from "../core/ask";

const status = (msg: string) => toast(msg);
/** Progress and problems while importing, in the import dialog. */
const impStatus = (msg: string) => { $("#importStatus").textContent = msg; };
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
        <span class="list-name" title="${esc(l.name)}">${esc(l.name)} <span class="hint">${l.count}</span></span>
        <span class="hint list-src">${esc(syncing.has(l.name) ? "Syncing…" : syncNote.get(l.name) || sourceText(l))}</span></label>
      <div class="list-tools">${on.has(l.name) ? `<button type="button" class="list-suggest${listSuggest(l.name) ? " on" : ""}" data-suggest="${esc(l.name)}" aria-pressed="${listSuggest(l.name)}" title="${listSuggest(l.name)
        ? "Suggested to the planner: it may pick from these places where they fit. Click to stop (then only the ones you star go)"
        : "Not suggested: only the places you star go to the planner. Click to let it pick from all of them"}">${icon("sparkles")}<span>${listSuggest(l.name) ? "Suggest" : "Off"}</span></button>` : ""}
      ${["google", "csv"].includes(l.source?.type || "") ? `<button type="button" class="icon-btn" data-sync="${esc(l.name)}" title="Re-import this list from its source" ${syncing.has(l.name) ? "disabled" : ""}>${icon("refresh")}</button>` : ""}
      <button type="button" class="icon-btn" data-del="${esc(l.name)}" title="Remove this list">${icon("trash")}</button></div>
    </div>`).join("")
    : `<button type="button" class="list-empty" id="importEmpty">${icon("plus")}<span><b>Import a place list</b><br><span class="hint">Mark everything interesting in Google Maps, save it to a list, and bring it in.</span></span></button>`;
  const n = on.size, sug = [...on].filter(listSuggest).length;
  $("#listMeta").textContent = n ? `${n} list${n > 1 ? "s" : ""} on the map · ${sug} suggested to the planner` : "";
  $$<HTMLInputElement>("[data-list]", el).forEach((b) => {
    b.onchange = () => {
      const names = session.lists.map((l) => l.name).filter((x) => (x === b.dataset.list ? b.checked : on.has(x)));
      setTickedLists(names); save(); renderPicker(); loadList();
    };
  });
  $$<HTMLButtonElement>("[data-suggest]", el).forEach((b) => {
    b.onclick = () => {
      const name = b.dataset.suggest!;
      state.listSuggest = { ...state.listSuggest, [name]: !listSuggest(name) };
      save(); renderPicker(); loadList({ autoSync: false });
      toast(listSuggest(name) ? `The planner may pick from "${name}" as suggestions` : `From "${name}", only the places you star go to the planner`);
    };
  });
  document.querySelector<HTMLButtonElement>("#importEmpty")?.addEventListener("click", openImport);
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
/** Loads the places of every ticked list. Google lists re-sync quietly when they're more than an hour old. `fit`: the
 *  map is fitted to the trip afterwards (not when the same trip only changed: the map stays where it is). */
export async function loadList({ autoSync = true, fit = true } = {}) {
  const names = tickedLists().filter((n) => metaOf(n));
  const mine = ++loading;
  if (!names.length) { session.fullTitles = new Set(); setListPlaces([]); renderChips(); drawMap({ fit }); return; }
  try {
    const lists = await Promise.all(names.map((n) => api<PlaceList>("/api/lists/" + encodeURIComponent(n))));
    if (mine !== loading) return; // ticked something else meanwhile
    session.fullTitles = new Set(lists.filter((_l, k) => listSuggest(names[k])).flatMap((l) => l.places.map((p) => p.title)));
    setListPlaces(merge(lists.map((l, k) => l.places.map((p) => ({ ...p, from: names[k] })))));
    renderChips(); renderItinerary(); drawMap({ fit }); geocodePlaces();
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
    // (A quiet sync in the background leaves the map where it is.)
    await loadList({ autoSync: false, fit: !quiet });
    if (!quiet || before !== list.places.length) status(`Synced "${name}": ${list.places.length} places.`);
  } catch (e) {
    syncing.delete(name);
    syncNote.set(name, `Sync failed: ${(e as Error).message}`);
    renderPicker();
  }
}

async function removeList(name: string) {
  const m = metaOf(name);
  if (!m || !await askConfirm({ title: `Remove the place list “${name}”?`, ...(m.source?.type === "csv" ? { text: "The CSV file stays; it's added again the next time the planner starts." } : {}), ok: "Remove", danger: true })) return;
  await api("/api/lists/" + encodeURIComponent(name), { method: "DELETE" });
  setTickedLists(tickedLists().filter((n) => n !== name)); save();
  await refreshLists(); loadList();
}

/** A newly imported list is ticked, next to the ones already ticked, suggested to the planner as chosen in the dialog. */
async function useImported(list: PlaceList, autoSync: boolean) {
  const all = $<HTMLInputElement>("#impAll").checked;
  state.listSuggest = { ...state.listSuggest, [list.name]: all };
  setTickedLists([...tickedLists(), list.name]); save();
  await refreshLists(); await loadList({ autoSync });
  $<HTMLDialogElement>("#importDialog").close();
  toast(`Imported "${list.name}" (${list.places.length} places)${all ? "" : ": star the ones you want in the plan"}`);
}

export function openImport() {
  impStatus("");
  $<HTMLDialogElement>("#importDialog").showModal();
  $<HTMLInputElement>("#gmUrl").focus();
}

async function importCsv(file: File) {
  const name = $<HTMLInputElement>("#csvName").value.trim() || file.name.replace(/\.csv$/i, "");
  impStatus(`Importing "${name}"…`);
  try {
    await useImported(await api<PlaceList>("/api/lists/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify({ csv: await file.text() }) }), true);
    $<HTMLInputElement>("#csvName").value = "";
  } catch (err) { impStatus((err as Error).message); }
}

export function openPlaces() {
  const dlg = $<HTMLDialogElement>("#placesDialog");
  if (!dlg.open) dlg.showModal();
}

export function initLists() {
  $("#openImport").onclick = openImport;
  $("#openPlaces").onclick = openPlaces;
  const places = $<HTMLDialogElement>("#placesDialog");
  places.addEventListener("click", (e) => { if (e.target === places) places.close(); });
  const dlg = $<HTMLDialogElement>("#importDialog");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // a click on the backdrop closes it
  $<HTMLFormElement>("#gmForm").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#gmUrl"), btn = $<HTMLButtonElement>("#gmImport");
    const url = input.value.trim();
    if (!url) return input.focus();
    btn.disabled = true; impStatus("Importing from Google Maps… (a big list takes a moment)");
    try {
      await useImported(await api<PlaceList>("/api/lists/import", { method: "POST", body: JSON.stringify({ url }) }), false);
      input.value = "";
    } catch (err) { impStatus((err as Error).message); }
    finally { btn.disabled = false; }
  };
  const file = $<HTMLInputElement>("#csvFile");
  file.onchange = () => { const f = file.files?.[0]; file.value = ""; if (f) importCsv(f); };
  const drop = $("#csvDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = e.dataTransfer?.files[0];
    if (f) importCsv(f);
  });
}
