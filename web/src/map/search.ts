// The main map's search bar (see place-search.ts): picking a result goes there and opens the add form for it.
import * as L from "leaflet";
import type { GeoHit } from "../../../shared/types";
import { $ } from "../core/dom";
import { session } from "../core/state";
import { openAddPopup } from "./add";
import { map } from "./map";
import { moveTo } from "./move";
import { type PlaceSearch, placeSearch } from "./place-search";

let bar: PlaceSearch | null = null;

/** Closes the results; true when they were open (a click on the map then only closes them). */
export const closeMapSearch = () => !!bar?.close();

function pick(r: GeoHit) {
  if (!map) return;
  const at = L.latLng(r.lat, r.lng);
  session.userMoved = true;
  map.closePopup();
  const open = () => openAddPopup(at, { name: r.name, label: r.label, fromList: session.places.some((p) => p.title === r.name) });
  map.once("moveend", open);
  moveTo(map, at, 16);
}

export function initMapSearch() {
  bar = placeSearch($<HTMLFormElement>("#mapSearch"), { map: () => map, placeholder: "Search places, streets, stations", onPick: pick });
}
