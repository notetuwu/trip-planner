// Google Maps directions for each stop: from the previous stop (or the hotel, for the day's first stop) in the mode
// the transport text describes. Transfers named "Salzburg → Hallstatt" use the two names as start and end.
import type { Day, ItineraryItem } from "../../../shared/types";
import { state } from "../core/state";
import { type ByTitle, byTitleMap, daySegments, itemLoc } from "../geo/item-loc";
import { type Loc, distKm, stayLoc, stayOn } from "../geo/locate";
import { FOOT } from "../map/routes";
import { chosenMode, cleanStop, splitGroup, transferEnds } from "../trip/modes";

const TRANSIT = /\b(bus|buses|coach|train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn|u-?bahn|metro|subway|tram|vaporetto|ferry|boat|funicular|cable car|line \d+)\b/i;
const DRIVE = /\b(taxi|uber|car|drive|driving|rental)\b/i;
const BIKE = /\b(bike|bicycle|cycle|cycling)\b/i;

function travelMode(x: ItineraryItem, km: number | null) {
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

/** How to point Google at a stop: exact coordinates when known, else "name, town". A transfer ends where it arrives. */
function stopRef(x: ItineraryItem, d: Day, byTitle: ByTitle): StopRef {
  const ends = transferEnds(x);
  if (ends) return { text: ends[1], loc: null };
  const loc = itemLoc(x, d, byTitle);
  if (loc && !loc.approx) return { text: `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`, loc };
  const town = daySegments(d)[0], name = cleanStop(x.place);
  return { text: town && !name.toLowerCase().includes(town.toLowerCase()) ? `${name}, ${town}` : name, loc };
}

/** The stop before this one on the same path (a split group continues from its own previous stop). */
function prevStop(d: Day, xi: number) {
  const g = splitGroup(d.items[xi]);
  for (let i = xi - 1; i >= 0; i--) { const pg = splitGroup(d.items[i]); if (!pg || pg === g || !g) return d.items[i]; }
  return null;
}

export function directionsUrl(di: number, xi: number): string | null {
  const d = state.itinerary?.days[di], x = d?.items[xi];
  if (!d || !x) return null;
  const byTitle = byTitleMap();
  let from: string, to: string, km: number | null = null;
  const ends = transferEnds(x);
  if (ends) [from, to] = ends;
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
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: from, destination: to, travelmode: travelMode(x, km) })}`;
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
