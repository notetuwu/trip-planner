// Real roads and paths between stops. Walking via the FOSSGIS router, driving via the OSRM demo (FOSSGIS as backup).
// Both are free public servers that ask for at most about one request per second, so each mode has its own queue.
import type { LatLng, Route, RouteMode } from "../../shared/types";
import { USER_AGENT, errMsg, sleep } from "../config";
import { diskCache } from "../util/disk-cache";

const routeCache = diskCache<Route | null>("routes.json");
const ROUTERS: Record<RouteMode, string[]> = {
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/foot"],
  car: ["https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"],
};
const routeKey = (mode: RouteMode, a: LatLng, b: LatLng) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

interface RouteJob { a: LatLng; b: LatLng; key: string }
const queues: Record<RouteMode, RouteJob[]> = { foot: [], car: [] };
const busy: Record<RouteMode, boolean> = { foot: false, car: false };

async function fetchRoute(mode: RouteMode, a: LatLng, b: LatLng): Promise<Route | null> {
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
  runQueue("foot"); runQueue("car");
  return { routes, pending };
}
