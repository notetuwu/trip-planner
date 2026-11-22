// Routes between stops along real streets and roads, fetched through the server (which queues and caches them).
import type { Day, ItineraryItem, LatLng, Route, RouteMode } from "../../../shared/types";
import { api } from "../core/dom";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc } from "../geo/locate";
import { state } from "../core/state";
import { chosenMode, modeOf, splitGroup } from "../trip/modes";
import { setMapStatus } from "./status";
import { DRIVE_KM, arrivalStay, isTransfer, viaStops } from "./travel-day";

/** Route key -> route, or null if there is none. */
export const routes: Record<string, Route | null> = {};
export const routeKey = (mode: RouteMode, a: LatLng, b: LatLng) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

/** How a leg is drawn: along footpaths, roads or railways, or as a straight line (water, air, short hops). */
export type LegMode = RouteMode | "straight";
/** group: the split group whose leg it is (from or to one of its stops), "" when everyone travels together. */
export interface Leg { xi: number; fromXi: number; mode: LegMode; from: LatLng; to: LatLng; group?: string }

/** The routed path for a leg: a route, null (none exists or not routable), or undefined (still being routed). */
export const legRoute = (leg: { mode: LegMode; from: LatLng; to: LatLng }) => (leg.mode === "straight" ? null : routes[routeKey(leg.mode, leg.from, leg.to)]);

// From the stop's transport text ("Walk, 5 min", "Bus 710", "Railjet to Munich"), else by distance. Trains of some
// length follow the tracks; water, air, cable cars and short rail hops stay straight lines.
const RAIL = /\b(train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn|u-?bahn|metro|subway|tram|vaporetto|ferry|boat|ship|flight|fly|plane|cable car|funicular|gondola)\b/i;
const ROAD = /\b(bus|coach|taxi|uber|car|drive|driving|shuttle|transfer)\b/i;
const TRAIN = /\b(train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn|shinkansen|limited express|jr|tgv|frecciarossa|italo|ave)\b/i;
export const FOOT = /\b(walk|walking|on foot|stroll|hike|zu fu)/i;
// A real hike can be long; "walk" usually means the last bit from the car park or the station.
const HIKE = /\b(hike|hiking|trail|trek|wander)/i;
const walkable = (t: string, km: number) => km < 2.5 || (HIKE.test(t) && km < 15);

function legMode(x: ItineraryItem, a: LatLng, b: LatLng, dayMode = ""): LegMode | null {
  const t = String(x.transport || ""), km = distKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
  if (km < 0.03) return null;
  const m = chosenMode(x) || (km > 2 && !(FOOT.test(t) && walkable(t, km)) ? dayMode : "");
  if (m === "car" || m === "bus") return "car";
  if (m === "train") return km > 5 ? "train" : "straight";
  if (m && m !== "bike") return "straight";
  if (TRAIN.test(t) && km > 5) return "train";
  if (RAIL.test(t) && km > 2) return "straight";
  if (FOOT.test(t) && walkable(t, km)) return "foot";
  if (ROAD.test(t)) return "car";
  return km < 1.5 ? "foot" : km < 80 ? "car" : "straight";
}

/** The legs of a day: from each stop to the next one with a location (each split group follows its own path). */
export function dayLegs(d: Day, byTitle: ByTitle): Leg[] {
  // Transfers are movements, not places; on a travel day the long legs are the drive between the stays, drawn as one
  // line with the stays (see travel-day.ts), and other legs follow the mode picked for that drive.
  const pts = d.items.map((x, xi) => ({ x, xi, loc: isTransfer(x) ? null : itemLoc(x, d, byTitle) })).filter((p) => p.loc);
  const arrive = arrivalStay(d);
  const drive = arrive > 0 && !!stayLoc(state.stays[arrive - 1]) && !!stayLoc(state.stays[arrive]);
  // Between two stops on the way, the drive line is the route, however short.
  const via = new Set(drive ? viaStops(arrive, byTitle).map((v) => v.xi) : []);
  const dayMode = arrive > 0 ? state.stays[arrive].travel || "" : "";
  const groups = [...new Set(d.items.map(splitGroup).filter(Boolean))];
  const paths = groups.length ? groups.map((g) => pts.filter((p) => !splitGroup(p.x) || p.x.group === g)) : [pts];
  // Keyed by both ends: two groups heading to the same stop (the dinner where they meet again) are two legs.
  const legs = new Map<string, Leg>();
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const from: LatLng = [path[i - 1].loc!.lat, path[i - 1].loc!.lng], to: LatLng = [path[i].loc!.lat, path[i].loc!.lng];
      if (drive && (distKm({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] }) > DRIVE_KM || (via.has(path[i - 1].xi) && via.has(path[i].xi)))) continue;
      // A transfer between the two stops ("Hiroshima → Shin-Osaka (train)") says how this leg goes.
      const group = splitGroup(path[i - 1].x) || splitGroup(path[i].x);
      const between = d.items.slice(path[i - 1].xi + 1, path[i].xi).filter((x) => isTransfer(x) && (!splitGroup(x) || splitGroup(x) === group));
      const byTransfer = between.map((x) => chosenMode(x) || modeOf(x)).find(Boolean) || "";
      const mode = legMode(path[i].x, from, to, byTransfer || dayMode);
      if (mode) legs.set(`${path[i - 1].xi}>${path[i].xi}`, { xi: path[i].xi, fromXi: path[i - 1].xi, mode, from, to, group });
    }
  }
  return [...legs.values()];
}

const wanted = new Map<string, { mode: RouteMode; from: LatLng; to: LatLng }>();
let timer: number | null = null, redraw: number | undefined;
let onRouted: () => void = () => {};
/** What to do when new routes arrive (redraw the map and leg info). */
export const setOnRouted = (fn: () => void) => { onRouted = fn; };

export function requestRoutes(legs: { mode: LegMode; from: LatLng; to: LatLng }[]) {
  for (const l of legs) {
    if (l.mode === "straight") continue;
    const k = routeKey(l.mode, l.from, l.to);
    if (!(k in routes)) wanted.set(k, { mode: l.mode, from: l.from, to: l.to });
  }
  if (wanted.size && !timer) timer = window.setTimeout(poll, 300);
}

async function poll() {
  timer = null;
  if (!wanted.size) return;
  try {
    const { routes: got, pending } = await api<{ routes: Record<string, Route | null>; pending: number }>("/api/routes", {
      method: "POST", body: JSON.stringify({ legs: [...wanted.values()] }),
    });
    Object.assign(routes, got);
    for (const k of Object.keys(got)) wanted.delete(k);
    if (Object.keys(got).length) { clearTimeout(redraw); redraw = window.setTimeout(onRouted, 200); }
    if (pending) { setMapStatus(`Routing ${pending} leg${pending > 1 ? "s" : ""}…`); timer = window.setTimeout(poll, 2500); }
    else setMapStatus("");
  } catch { timer = window.setTimeout(poll, 5000); }
}
