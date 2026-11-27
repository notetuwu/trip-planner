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

/** Where a stop goes in a day by its time: before the first stop that starts later (at the end without a time). */
function slotFor(items: ItineraryItem[], time: string) {
  const t = toMin(time);
  if (t == null) return items.length;
  const at = items.findIndex((x) => { const m = toMin(x.time); return m != null && m > t; });
  return at < 0 ? items.length : at;
}

const dayTotal = (items: ItineraryItem[]) => items.reduce((n, y) => n + (Number(y.cost) || 0), 0);

/** Moves a stop to another day, keeping its time (or giving it a new one), in time order there. Undo puts it back. */
export function moveStopTo(di: number, xi: number, toDi: number, time?: string) {
  const days = state.itinerary?.days, from = days?.[di], to = days?.[toDi];
  if (!from || !to || di === toDi || !from.items[xi]) return;
  const before = { from: [...from.items], to: [...to.items], fromCost: from.estimatedCost, toCost: to.estimatedCost };
  const [x] = from.items.splice(xi, 1);
  const was = x.time, leg = x.leg;
  if (time) x.time = time;
  // A way set by hand went from the stop before it on its old day.
  delete x.leg;
  to.items.splice(slotFor(to.items, x.time), 0, x);
  from.estimatedCost = dayTotal(from.items); to.estimatedCost = dayTotal(to.items);
  save(); renderItinerary(); drawMap({ fit: false });
  toast(`Moved “${x.place}” to day ${toDi + 1} (${fmtDate(to.date)})`, () => {
    x.time = was;
    if (leg) x.leg = leg;
    from.items = before.from; to.items = before.to; from.estimatedCost = before.fromCost; to.estimatedCost = before.toCost;
    save(); renderItinerary(); drawMap({ fit: false });
  });
}

/** Swaps what two days do (their stops, title, town and notes); the dates stay where they are. Undo swaps them back. */
export function swapDays(a: number, b: number) {
  const days = state.itinerary?.days, da = days?.[a], db = days?.[b];
  if (!da || !db || a === b) return;
  const swap = () => {
    for (const k of ["city", "title", "items", "notes", "estimatedCost"] as const) { const t = da[k]; (da as any)[k] = db[k]; (db as any)[k] = t; }
    if (!da.notes) delete da.notes;
    if (!db.notes) delete db.notes;
    save(); renderItinerary(); drawMap({ fit: false });
  };
  swap();
  toast(`Swapped day ${a + 1} and day ${b + 1}`, swap);
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
