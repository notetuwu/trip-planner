// Raw OpenStreetMap places around a point, from the public Overpass servers, cached on disk for 30 days.
import { USER_AGENT, sleep } from "../config";
import { locateTown } from "../geo/geocode";
import { diskCache } from "../util/disk-cache";

export interface OsmElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const nearbyCache = diskCache<{ at: number; elements: OsmElement[] }>("nearby.json");
// Volunteer-run servers, most reliable first. A city can take 30 s, and the main one allows only two
// parallel queries per visitor (so callers fetch at most 2 towns at a time).
export const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function overpassAround(lat: number, lng: number): Promise<OsmElement[]> {
  // Sights and food are capped separately, so a big city's hundreds of restaurants can't crowd out its sights.
  const q = `[out:json][timeout:55];
    nwr(around:2500,${lat},${lng})["amenity"~"^(restaurant|cafe|biergarten|ice_cream|fast_food|bar|pub)$"]["name"]->.food;
    (nwr(around:7000,${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["name"];
     nwr(around:7000,${lat},${lng})["historic"~"^(castle|monument|ruins|fort|palace|church|city_gate|archaeological_site)$"]["name"];)->.sights;
    .sights out center tags 400;
    .food out center tags 300;`;
  // Two rounds over all servers: busy servers often answer a little later.
  let lastErr: unknown;
  for (let round = 0; round < 2; round++) {
    if (round) await sleep(10000);
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(65000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((await res.json()) as any).elements || [];
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}

/** Fetched only once even when the background warm-up and a generation ask at the same time. */
const inflight = new Map<string, Promise<OsmElement[]>>();

export async function nearbyElements(city: string, cc?: string, onStatus: (s: string) => void = () => {}): Promise<OsmElement[] | null> {
  const town = await locateTown(city, cc);
  if (!town) return null;
  const key = `${town.lat.toFixed(3)},${town.lng.toFixed(3)}`;
  const hit = nearbyCache.data[key];
  if (hit && Date.now() - hit.at < 30 * 864e5) return hit.elements;
  onStatus(`Finding real places around ${city}…`);
  if (!inflight.has(key)) {
    inflight.set(key, overpassAround(town.lat, town.lng).then((els) => {
      const elements = els.map(({ lat, lon, center, tags }) => ({ lat, lon, center, tags }));
      nearbyCache.data[key] = { at: Date.now(), elements };
      nearbyCache.saveNow();
      return elements;
    }).finally(() => inflight.delete(key)));
  }
  return inflight.get(key)!;
}

/** Runs fn over items, at most `limit` at a time. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}
