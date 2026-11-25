// Directions for each stop (in the maps app chosen in Settings): from the previous stop (or the hotel, for the day's
// first stop) in the mode the transport text describes. Transfers named "Salzburg → Hallstatt" use the two names as
// start and end. A meal with no particular place ("Lunch in Vaduz") opens a search for restaurants there instead.
import type { Day, ItineraryItem } from "../../../shared/types";
import { state } from "../core/state";
import { type ByTitle, activityTown, byTitleMap, daySegments, itemLoc } from "../geo/item-loc";
import { type TravelMode, directionsLink, genericMeal, searchUrl } from "../core/maps-links";
import { type Loc, distKm, stayLoc, stayOn } from "../geo/locate";
import { FOOT } from "../map/routes";
import { chosenMode, cleanStop, onWayOf, splitGroup, transferEnds } from "../trip/modes";

const TRANSIT = /\b(bus|buses|coach|train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn|u-?bahn|metro|subway|tram|vaporetto|ferry|boat|funicular|cable car|line \d+)\b/i;
const DRIVE = /\b(taxi|uber|car|drive|driving|rental)\b/i;
const BIKE = /\b(bike|bicycle|cycle|cycling)\b/i;

function travelMode(x: ItineraryItem, km: number | null): TravelMode {
  const m = chosenMode(x);
  if (m) return m === "car" ? "driving" : m === "bike" ? "bicycling" : "transit";
  const t = `${x.transport || ""} ${x.place || ""}`;
  if (TRANSIT.test(t)) return "transit"; // "Bus 260 or taxi" -> transit
  if (DRIVE.test(t)) return "driving";
  if (BIKE.test(t)) return "bicycling";
  if (FOOT.test(t)) return "walking";
  return km != null && km < 1.5 ? "walking" : "transit";
}

interface StopRef { text: string; loc: Loc | null }

/** How to point the maps app at a stop: exact coordinates when known, else "name, town". A transfer ends where it
 *  arrives; a walk in a town the name gives ("Kempten old town walk") goes to that town, not "…, Isny". */
function stopRef(x: ItineraryItem, d: Day, byTitle: ByTitle): StopRef {
  const ends = transferEnds(x);
  if (ends) return { text: ends[1], loc: null };
  const loc = itemLoc(x, d, byTitle);
  if (loc && !loc.approx) return { text: `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`, loc };
  const town = activityTown(x.place);
  if (town) return { text: town, loc };
  const meal = genericMeal(x.place);
  if (meal?.where) return { text: meal.where, loc };
  const day = daySegments(d)[0], name = cleanStop(x.place);
  return { text: day && !name.toLowerCase().includes(day.toLowerCase()) ? `${name}, ${day}` : name, loc };
}

/** "Lunch in Vaduz" or a plain "Dinner": what's there to eat, around the stop's spot (or in its town). */
export function mealSearchUrl(di: number, xi: number): string | null {
  const d = state.itinerary?.days[di], x = d?.items[xi];
  const meal = x && genericMeal(x.place);
  if (!d || !x || !meal) return null;
  const loc = itemLoc(x, d, byTitleMap());
  const where = meal.where || daySegments(d)[0] || "";
  return searchUrl(`${meal.what}${where ? ` ${where}` : ""}`, loc);
}

/** The stop before this one on the same path (a split group continues from its own previous stop). */
function prevStop(d: Day, xi: number) {
  const g = splitGroup(d.items[xi]);
  for (let i = xi - 1; i >= 0; i--) if (!g || onWayOf(d.items, d.items[i], g)) return d.items[i];
  return null;
}

export function directionsUrl(di: number, xi: number): string | null {
  const d = state.itinerary?.days[di], x = d?.items[xi];
  if (!d || !x) return null;
  // No route to a meal that isn't anywhere in particular: the list of restaurants there is what's useful.
  const meal = mealSearchUrl(di, xi);
  if (meal) return meal;
  const byTitle = byTitleMap();
  let from: string, to: string, km: number | null = null;
  const ends = transferEnds(x);
  if (ends) {
    // From where they are (the stop before: "Kriens" is the gondola station there, not the town's middle).
    const prev = prevStop(d, xi);
    [from, to] = [prev && !transferEnds(prev) ? stopRef(prev, d, byTitle).text : ends[0], ends[1]];
  }
  else {
    const b = stopRef(x, d, byTitle), prev = prevStop(d, xi);
    let a: StopRef | undefined;
    if (prev) a = stopRef(prev, d, byTitle);
    else {
      const stay = stayOn(d);
      if (stay) a = { text: stay.hotel ? `${stay.hotel}, ${stay.city}` : stay.city, loc: stayLoc(stay) };
    }
    if (!a) return null;
    from = a.text; to = b.text;
    // From the town to "<town> accommodation" on the first stop of a day isn't a route worth opening.
    if (!prev && to.toLowerCase().includes(from.toLowerCase().split(",")[0])) return null;
    if (a.loc && b.loc) km = distKm(a.loc, b.loc);
  }
  if (from === to) return null;
  return directionsLink(from, to, travelMode(x, km));
}

/** Links are filled in when clicked, so they use the latest locations. */
export function initDirectionLinks() {
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-dir]"); if (!a) return;
    const [di, xi] = a.dataset.dir!.split("-").map(Number);
    const url = directionsUrl(di, xi);
    if (url) a.href = url; else e.preventDefault();
  }, true);
}
