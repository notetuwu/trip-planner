// Adding and removing itinerary stops and map-picked places by hand.
import type { ItineraryItem, Place } from "../../../shared/types";
import { $, toast } from "../core/dom";
import { fmtDate } from "../core/format";
import { save, session, setListPlaces, state } from "../core/state";
import { renderItinerary } from "../itinerary/render";
import { renderChips } from "../places/chips";
import { toMin } from "./add";
import { drawMap } from "./draw";

/** Inserts a stop in time order and shows it. */
export function addStop(di: number, item: ItineraryItem) {
  const day = state.itinerary!.days[di], t = toMin(item.time) ?? 0;
  let at = day.items.findIndex((x) => { const m = toMin(x.time); return m != null && m > t; });
  if (at < 0) at = day.items.length;
  day.items.splice(at, 0, item);
  save();
  session.selectedDay = di;
  renderItinerary(); drawMap({ fit: true });
  const el = $(`.item[data-k="${di}-${at}"]`);
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  el?.classList.add("flash");
  toast(`Added “${item.place}” to ${fmtDate(day.date)}`);
}

/** Without an itinerary, a spot picked on the map becomes a must-see place for the next generation. */
export function addCustomPlace(p: Place & { lat: number; lng: number }) {
  if (session.places.some((x) => x.title === p.title)) p.title += " (map)";
  state.customPlaces.push({ ...p, custom: true, url: `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` });
  state.marks[p.title] = "must";
  setListPlaces(session.listPlaces); save(); renderChips(); drawMap();
  toast(`Added “${p.title}” as a must-see; Claude will fit it in when you generate`);
}

export function removeStop(di: number, xi: number) {
  const day = state.itinerary!.days[di];
  const [removed] = day.items.splice(xi, 1);
  save(); renderItinerary(); drawMap();
  toast(`Removed “${removed.place}”`, () => {
    day.items.splice(xi, 0, removed);
    save(); renderItinerary(); drawMap();
  });
}
