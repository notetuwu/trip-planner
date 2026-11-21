// Geocoding with a disk cache and a queue: results trickle in at about one per second, and the page polls for them.
import type { GeoHit, GeoQuery, LatLng, ReverseHit } from "../../shared/types";
import { errMsg } from "../config";
import { diskCache } from "../util/disk-cache";
import { nominatim, nominatimHit, photon, photonHit } from "./providers";

export type GeoEntry = GeoHit | ReverseHit | null;
export const geoCache = diskCache<GeoEntry | number>("geocode.json");
// Cache v2 added the Photon fallback: retry everything v1 couldn't find.
if (geoCache.data.__v !== 2) {
  for (const k of Object.keys(geoCache.data)) if (geoCache.data[k] === null) delete geoCache.data[k];
  geoCache.data.__v = 2;
}

/** The "near" point (rounded to ~10 km) is part of the key only when given, so older cache entries stay valid. */
export const geoKey = (q: string, cc?: string, near?: LatLng | null) =>
  `${String(q).trim().toLowerCase()}|${cc || ""}${near ? `|${(+near[0]).toFixed(1)},${(+near[1]).toFixed(1)}` : ""}`;

/**
 * `near` keeps results around that point, e.g. the town an itinerary stop is in, so a "Gasthaus zur Post"
 * is found in the right village rather than anywhere in the country.
 */
export async function geocodeOne(q: string, cc?: string, near?: LatLng | null): Promise<GeoHit | null> {
  const params = new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en" });
  if (cc) params.set("countrycodes", cc);
  if (near) {
    const [lat, lng] = near, d = 0.6; // roughly 50-65 km around the point
    params.set("viewbox", `${lng - d},${lat + d},${lng + d},${lat - d}`);
    params.set("bounded", "1");
  }
  const [hit] = await nominatim("search", params);
  if (hit) return nominatimHit(hit);
  // Fall back to Photon, also with the name cut before " - ", " | " or "(" (e.g. "Store - Shibuya Main Store").
  const ccs = (cc || "").split(",").filter(Boolean);
  const km = (f: any) => {
    if (!near) return 0;
    const [lng, lat] = f.geometry.coordinates, r = Math.PI / 180;
    return Math.hypot((lng - near[1]) * Math.cos(lat * r), lat - near[0]) * 111;
  };
  for (const name of new Set([q, q.replace(/\s+[-–|(].*$/, "")])) {
    const pp = new URLSearchParams({ q: name, limit: "5", lang: "en" });
    if (near) { pp.set("lat", String(near[0])); pp.set("lon", String(near[1])); }
    const f = (await photon(pp))
      .find((f) => (!ccs.length || ccs.includes((f.properties.countrycode || "").toLowerCase())) && km(f) < 60);
    if (f) return photonHit(f);
  }
  return null;
}

interface GeoJob { q: string; cc?: string; near: LatLng | null; key: string; first: boolean }
const geoQueue: GeoJob[] = [];
let geoBusy = false;

async function runGeoQueue() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const { q, cc, near, key } = geoQueue.shift()!;
    try { geoCache.data[key] = await geocodeOne(q, cc, near); geoCache.save(); }
    catch (e) { console.error("Geocode failed:", q, errMsg(e)); }
  }
  geoBusy = false;
}

/** Answers what's cached right away and queues the rest; the page asks again for those. */
export function geocodeBatch(queries: GeoQuery[]) {
  const results: Record<string, unknown> = {};
  let pending = 0;
  for (const { q, cc, near: n, first } of queries.slice(0, 1000)) {
    const near = Array.isArray(n) && n.length === 2 && n.every(isFinite) ? (n.map(Number) as LatLng) : null;
    if (!q || !String(q).trim()) continue;
    const key = geoKey(q, cc, near);
    if (key in geoCache.data) { results[key] = geoCache.data[key]; continue; }
    pending++;
    const queued = geoQueue.findIndex((x) => x.key === key);
    const job = { q: String(q).trim(), cc, near, key, first: !!first };
    // Stays and itinerary stops jump ahead of the (often long) saved-places backlog, but stay in the order they
    // were asked for among themselves (a day's town must be found before the stops searched around it).
    if (first && !geoQueue[queued]?.first) {
      if (queued >= 0) geoQueue.splice(queued, 1);
      const at = geoQueue.findIndex((x) => !x.first);
      geoQueue.splice(at < 0 ? geoQueue.length : at, 0, job);
    } else if (queued < 0) geoQueue.push(job);
  }
  runGeoQueue();
  return { results, pending, queued: geoQueue.length };
}

/** A town's location, looked up now if it isn't cached (used before fetching places around it). */
export async function locateTown(q: string, cc?: string): Promise<GeoHit | null> {
  const key = geoKey(q, cc);
  if (!(key in geoCache.data)) { geoCache.data[key] = await geocodeOne(q, cc); geoCache.save(); }
  return geoCache.data[key] as GeoHit | null;
}
