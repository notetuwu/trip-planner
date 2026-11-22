// Real roads, paths and railways between stops. Walking via the FOSSGIS router, driving via the OSRM demo (FOSSGIS as
// backup), trains via Transitous (a community-run public transport router, see transitous.org). All are free public
// servers that ask for at most about one request per second, so each mode has its own queue.
import type { LatLng, Route, RouteMode } from "../../shared/types";
import { USER_AGENT, errMsg, sleep } from "../config";
import { diskCache } from "../util/disk-cache";

const routeCache = diskCache<Route | null>("routes.json");
const ROUTERS: Record<RouteMode, string[]> = {
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/foot"],
  car: ["https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"],
  train: ["https://api.transitous.org/api/v5/plan"],
};
const MODES = Object.keys(ROUTERS) as RouteMode[];
// "No train connection" answers from before the router was allowed longer walks to the stations: ask once more.
// Also train routes from before they marked their stations.
for (const k of Object.keys(routeCache.data)) if (k.startsWith("train:") && (routeCache.data[k] === null || !routeCache.data[k]!.rail)) delete routeCache.data[k];
const routeKey = (mode: RouteMode, a: LatLng, b: LatLng) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

interface RouteJob { a: LatLng; b: LatLng; key: string }
const queues: Record<RouteMode, RouteJob[]> = { foot: [], car: [], train: [] };
const busy: Record<RouteMode, boolean> = { foot: false, car: false, train: false };

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
const thin = (c: LatLng[], max = 1500) => { if (c.length <= max) return c; const step = Math.ceil(c.length / max); return c.filter((_, i) => i % step === 0 || i === c.length - 1); };

/**
 * The quickest train connection (walking to and from the stations included) along the real tracks; null if there's
 * no connection by rail. The timetable doesn't matter for the line on the map, so it asks for the next departures.
 */
async function fetchRail(base: string, a: LatLng, b: LatLng): Promise<Route | null> {
  // A town's or hotel's point is often more than the router's default 15-minute walk from a station (Onomichi's is),
  // which made it answer "no connection": allow 30 minutes, then an hour.
  let its: any[] = [];
  for (const walk of [1800, 3600]) {
    const q = new URLSearchParams({
      fromPlace: `${a[0]},${a[1]}`, toPlace: `${b[0]},${b[1]}`, maxPreTransitTime: String(walk), maxPostTransitTime: String(walk),
      transitModes: "RAIL,SUBURBAN,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,REGIONAL_FAST_RAIL,METRO,SUBWAY,TRAM,FUNICULAR",
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

async function fetchRoute(mode: RouteMode, a: LatLng, b: LatLng): Promise<Route | null> {
  if (mode === "train") return fetchRail(ROUTERS.train[0], a, b);
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

async function runQueue(mode: RouteMode) {
  if (busy[mode]) return;
  busy[mode] = true;
  while (queues[mode].length) {
    const { a, b, key } = queues[mode].shift()!;
    const t0 = Date.now();
    try { routeCache.data[key] = await fetchRoute(mode, a, b); routeCache.save(); }
    catch (e) { console.error(`Routing (${mode}) failed:`, errMsg(e)); }
    await sleep(Math.max(0, 1050 - (Date.now() - t0)));
  }
  busy[mode] = false;
}

interface LegRequest { mode: RouteMode; from: LatLng; to: LatLng }

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
  for (const { mode, from, to } of legs.slice(0, 600)) {
    if (!ROUTERS[mode] || !Array.isArray(from) || !Array.isArray(to) || ![...from, ...to].every((n) => isFinite(n))) continue;
    const a = from.map(Number) as LatLng, b = to.map(Number) as LatLng;
    const key = routeKey(mode, a, b);
    if (key in routeCache.data) { routes[key] = routeCache.data[key]; continue; }
    pending++;
    if (!queues[mode].some((x) => x.key === key)) queues[mode].push({ a, b, key });
  }
  for (const m of MODES) runQueue(m);
  return { routes, pending };
}
