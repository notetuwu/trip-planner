// Real roads, paths, railways and boat routes between stops. Walking and cycling via the FOSSGIS router, driving via the
// OSRM demo (FOSSGIS as backup), trains, boats, lifts, trams, metros and bus lines via Transitous (a community-run public
// transport router, see transitous.org). All are free public servers that ask for at most about one request per second,
// so each server has its own queue.
import type { LatLng, Route, RouteMode } from "../../shared/types";
import { USER_AGENT, errMsg, sleep } from "../config";
import { diskCache } from "../util/disk-cache";

const routeCache = diskCache<Route | null>("routes.json");
const TRANSITOUS = "https://api.transitous.org/api/v5/plan";
const ROUTERS: Record<RouteMode, string[]> = {
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/foot"],
  bike: ["https://routing.openstreetmap.de/routed-bike/route/v1/bike"],
  car: ["https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"],
  train: [TRANSITOUS], ferry: [TRANSITOUS], lift: [TRANSITOUS], transit: [TRANSITOUS],
};
/** Which public transport Transitous may use for each mode it routes. */
const TRANSIT: Partial<Record<RouteMode, string>> = {
  train: "RAIL,SUBURBAN,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,REGIONAL_FAST_RAIL,METRO,SUBWAY,TRAM,FUNICULAR",
  ferry: "FERRY",
  // Gondolas, cable cars and chairlifts (through their middle stations), and funiculars.
  lift: "AERIAL_LIFT,FUNICULAR",
  // In town: trams, metros and bus lines.
  transit: "TRAM,SUBWAY,BUS,COACH",
};
/** Modes whose route must be mostly the ride itself, not a long walk to somewhere it happens to go near. */
const RIDE_ONLY: RouteMode[] = ["ferry", "lift", "transit"];
/** The queue each mode waits in: one per server (walking and cycling share FOSSGIS; trains, boats, lifts and town
 *  transport share Transitous), so each server is still asked about once a second. */
type Queue = "foot" | "car" | "transit";
const queueOf = (mode: RouteMode): Queue => (TRANSIT[mode] ? "transit" : mode === "car" ? "car" : "foot");
const QUEUES: Queue[] = ["foot", "car", "transit"];
// "No train connection" answers from before the router was allowed longer walks to the stations: ask once more.
// Also train routes from before they marked their stations.
for (const k of Object.keys(routeCache.data)) if (k.startsWith("train:") && (routeCache.data[k] === null || !routeCache.data[k]!.rail)) delete routeCache.data[k];
const routeKey = (mode: RouteMode, a: LatLng, b: LatLng) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

interface RouteJob { mode: RouteMode; a: LatLng; b: LatLng; key: string; when?: string }
const queues: Record<Queue, RouteJob[]> = { foot: [], car: [], transit: [] };
const busy: Record<Queue, boolean> = { foot: false, car: false, transit: false };

/** Decodes a Google-style encoded polyline (`precision` decimal places) into [lat, lng] pairs. */
export function decodePolyline(s: string, precision = 5): LatLng[] {
  const out: LatLng[] = [], f = 10 ** precision;
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) { lat += next(); lng += next(); out.push([lat / f, lng / f]); }
  return out;
}

const kmBetween = (a: LatLng, b: LatLng) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * r), y = b[0] - a[0];
  return Math.hypot(x, y) * 111.2;
};
/**
 * A "boat" (or lift) connection that is mostly walking (the boat goes somewhere near, and the rest is an hour on foot, like a
 * boat to a town across the lake from a place that's inland) isn't a boat route: the map draws a straight line instead.
 */
function mostlyWalking(r: Route) {
  if (!r.rail) return true;
  const len = (c: LatLng[]) => c.slice(1).reduce((n, p, k) => n + kmBetween(c[k], p), 0);
  const ride = len(r.c.slice(r.rail[0], r.rail[1] + 1)), walk = len(r.c.slice(0, r.rail[0] + 1)) + len(r.c.slice(r.rail[1]));
  return walk > 3 || walk > ride;
}
// Boat routes kept from before: the mostly-walking ones count as no route, and "no boat" answers are asked again (they
// were asked for today's boats, and many lake boats only run in summer: now they're asked for the trip's day).
for (const k of Object.keys(routeCache.data)) {
  if (!k.startsWith("ferry:")) continue;
  const r = routeCache.data[k];
  if (r === null) delete routeCache.data[k];
  else if (r && mostlyWalking(r)) routeCache.data[k] = null;
}

const thin = (c: LatLng[], max = 1500) => { if (c.length <= max) return c; const step = Math.ceil(c.length / max); return c.filter((_, i) => i % step === 0 || i === c.length - 1); };

/**
 * The quickest train (or boat) connection, walking to and from the stations or piers included, along the real tracks or
 * boat route; null if there's none. It asks for departures on the trip's day when it's known (`when`: a summer boat
 * doesn't run in November), then for the next ones from now.
 */
async function fetchRail(base: string, a: LatLng, b: LatLng, modes: string, when?: string): Promise<Route | null> {
  // A town's or hotel's point is often more than the router's default 15-minute walk from a station (Onomichi's is),
  // which made it answer "no connection": allow 30 minutes, then an hour.
  let its: any[] = [];
  const tries = [...(when ? [when] : []), ""].flatMap((time) => [1800, 3600].map((walk) => ({ time, walk })));
  for (const { time, walk } of tries) {
    const q = new URLSearchParams({
      fromPlace: `${a[0]},${a[1]}`, toPlace: `${b[0]},${b[1]}`, maxPreTransitTime: String(walk), maxPostTransitTime: String(walk),
      transitModes: modes, ...(time ? { time } : {}),
    });
    const res = await fetch(`${base}?${q}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    its = (j.itineraries || []).filter((it: any) => it.legs?.some((l: any) => l.mode !== "WALK"));
    if (its.length) break;
  }
  if (!its.length) return null;
  const it = its.reduce((x: any, y: any) => (y.duration < x.duration ? y : x));
  const parts = it.legs.map((l: any) => ({ walk: l.mode === "WALK", pts: (l.legGeometry?.points ? decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 6) : []) as LatLng[] }));
  const c: LatLng[] = parts.flatMap((p: { pts: LatLng[] }) => p.pts);
  if (c.length < 2) return null;
  const d = c.slice(1).reduce((n, p, k) => n + kmBetween(c[k], p), 0) * 1000;
  const out: LatLng[] = thin(c).map(([lat, lng]) => [+lat.toFixed(5), +lng.toFixed(5)]);
  // Where the first train leaves and the last one arrives (the walks to and from the stations are the rest).
  const rides = parts.filter((p: { walk: boolean; pts: LatLng[] }) => !p.walk && p.pts.length);
  const nearest = (q: LatLng) => out.reduce((best, p, k) => (kmBetween(p, q) < kmBetween(out[best], q) ? k : best), 0);
  const rail: [number, number] | undefined = rides.length ? [nearest(rides[0].pts[0]), nearest(rides.at(-1).pts.at(-1))] : undefined;
  return { d: Math.round(d), t: Math.round(it.duration), c: out, ...(rail && rail[1] > rail[0] ? { rail } : {}) };
}

async function fetchRoute(mode: RouteMode, a: LatLng, b: LatLng, when?: string): Promise<Route | null> {
  if (TRANSIT[mode]) {
    const r = await fetchRail(ROUTERS[mode][0], a, b, TRANSIT[mode]!, when);
    return r && RIDE_ONLY.includes(mode) && mostlyWalking(r) ? null : r;
  }
  let lastErr: unknown;
  for (const base of ROUTERS[mode]) {
    try {
      const res = await fetch(`${base}/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`, {
        headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000),
      });
      const j: any = await res.json();
      if (j.code === "NoRoute") return null;
      if (!res.ok || j.code !== "Ok") throw new Error(j.message || `HTTP ${res.status}`);
      const r = j.routes[0];
      // Long drives (stay to stay) come back with many thousands of points; thin them to keep the cache small.
      let c: [number, number][] = r.geometry.coordinates;
      if (c.length > 1500) { const step = Math.ceil(c.length / 1500); c = c.filter((_, i) => i % step === 0 || i === c.length - 1); }
      // Stored as [lat, lng] pairs rounded to ~1 m, with distance (m) and duration (s).
      return { d: Math.round(r.distance), t: Math.round(r.duration), c: c.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function runQueue(q: Queue) {
  if (busy[q]) return;
  busy[q] = true;
  while (queues[q].length) {
    const { mode, a, b, key, when } = queues[q].shift()!;
    const t0 = Date.now();
    try { routeCache.data[key] = await fetchRoute(mode, a, b, when); routeCache.save(); }
    catch (e) { console.error(`Routing (${mode}) failed:`, errMsg(e)); }
    await sleep(Math.max(0, 1050 - (Date.now() - t0)));
  }
  busy[q] = false;
}

/** `when`: the day and time of the leg ("2027-09-10T08:15"), so trains and boats are looked up for that day. */
interface LegRequest { mode: RouteMode; from: LatLng; to: LatLng; when?: string }

/** One route, waiting for it if it isn't cached yet: the route, null if none exists, undefined if it took too long. */
export async function waitForRoute(mode: RouteMode, from: LatLng, to: LatLng, ms = 30000): Promise<Route | null | undefined> {
  const key = routeKey(mode, from, to), t0 = Date.now();
  routeBatch([{ mode, from, to }]);
  while (!(key in routeCache.data) && Date.now() - t0 < ms) await sleep(300);
  return routeCache.data[key];
}

/** Answers cached routes (null = no route exists) and queues the rest. */
export function routeBatch(legs: LegRequest[]) {
  const routes: Record<string, Route | null> = {};
  let pending = 0;
  for (const { mode, from, to, when } of legs.slice(0, 600)) {
    if (!ROUTERS[mode] || !Array.isArray(from) || !Array.isArray(to) || ![...from, ...to].every((n) => isFinite(n))) continue;
    const a = from.map(Number) as LatLng, b = to.map(Number) as LatLng;
    const key = routeKey(mode, a, b);
    if (key in routeCache.data) { routes[key] = routeCache.data[key]; continue; }
    pending++;
    const q = queues[queueOf(mode)];
    const at = typeof when === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) ? `${when}:00Z` : undefined;
    if (!q.some((x) => x.key === key)) q.push({ mode, a, b, key, when: at });
  }
  for (const q of QUEUES) runQueue(q);
  return { routes, pending };
}
