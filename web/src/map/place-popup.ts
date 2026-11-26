// Popups of saved places on the map: must-see / skip, rename or remove map-picked places, add to a day.
import * as L from "leaflet";
import type { Place } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { type Mark, save, session, setListPlaces, state } from "../core/state";
import { placeLoc } from "../geo/locate";
import { flashChip, renderChips, setMark } from "../places/chips";
import { openAddPopup } from "./add";
import { drawMap } from "./draw";
import { map } from "./map";
import { ext, icon } from "../core/icons";
import { mapsName, placeUrl } from "../core/maps-links";
import { askText } from "../core/ask";

export function placePopupHtml(p: Place) {
  const mark = state.marks[p.title];
  return `<b>${esc(p.title)}</b>${p.note ? `<div>${esc(p.note)}</div>` : ""}${p.address ? `<div class="pop-meta">${esc(p.address)}</div>` : ""}
    <div class="pop-actions">
      <button data-mark="${esc(p.title)}" data-v="must" class="${mark === "must" ? "on" : ""}">${icon("star")} Must-see</button>
      <button data-mark="${esc(p.title)}" data-v="skip" class="${mark === "skip" ? "on" : ""}">Skip</button>
      ${mark && !p.custom ? `<button data-mark="${esc(p.title)}" data-v="">Reset</button>` : ""}
      ${p.custom ? `<button data-rename-custom="${esc(p.title)}">Rename</button><button data-remove-custom="${esc(p.title)}">Remove</button>` : ""}
      <a href="${esc(placeUrl({ ...p, ...(placeLoc(p) || {}) }))}" target="_blank" rel="noopener" style="margin-left:auto" title="Open in ${esc(mapsName())}">Maps${ext()}</a>
    </div>
    ${state.itinerary ? `<div class="pop-actions"><button data-add-place="${esc(p.title)}">＋ Add to a day</button></div>` : ""}`;
}

const refresh = () => { setListPlaces(session.listPlaces); save(); renderChips(); map?.closePopup(); drawMap(); };

async function renameCustom(t: string) {
  const p = state.customPlaces.find((x) => x.title === t);
  const name = p && await askText({ title: "Rename place", value: t, ok: "Rename", required: true });
  if (!p || !name || name === t || session.places.some((x) => x.title === name)) return;
  p.title = name;
  // Marks and group sizes are keyed by name, so move them along.
  if (t in state.marks) { state.marks[name] = state.marks[t]; delete state.marks[t]; }
  if (t in state.who) { state.who[name] = state.who[t]; delete state.who[t]; }
  if (state.how && t in state.how) { state.how[name] = state.how[t]; delete state.how[t]; }
  refresh();
}

/** Hooks up the buttons of whichever popup just opened. */
export function wirePlacePopup(el: HTMLElement) {
  for (const b of $$("[data-add-place]", el)) b.onclick = () => {
    const p = session.places.find((x) => x.title === b.dataset.addPlace), loc = p && placeLoc(p);
    if (p && loc) openAddPopup(L.latLng(loc.lat, loc.lng), { name: p.title, label: p.address, fromList: true });
  };
  for (const b of $$("[data-remove-custom]", el)) b.onclick = () => {
    const t = b.dataset.removeCustom!;
    state.customPlaces = state.customPlaces.filter((p) => p.title !== t);
    delete state.marks[t]; delete state.who[t]; if (state.how) delete state.how[t];
    refresh();
  };
  for (const b of $$("[data-rename-custom]", el)) b.onclick = () => renameCustom(b.dataset.renameCustom!);
  for (const b of $$("[data-mark]", el)) b.onclick = () => {
    const t = b.dataset.mark!;
    map?.closePopup();
    setMark(t, (b.dataset.v || undefined) as Mark | undefined);
    flashChip(t);
  };
}
