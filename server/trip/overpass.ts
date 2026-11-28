// Raw OpenStreetMap places around a point, from the public Overpass servers, cached on disk for 30 days.
import { USER_AGENT, sleep } from "../config";
import { locateTown } from "../geo/geocode";
import { diskCache } from "../util/disk-cache";
import { WANT_KINDS } from "./prefs";

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
  "https://overpass.private.coffee/api/interpreter",
];

async function overpassAround(lat: number, lng: number, scale = 1): Promise<OsmElement[]> {
  // Sights and food are capped separately, so a big city's hundreds of restaurants can't crowd out its sights.
  const wide = Math.round(7000 * scale), near = Math.round(2500 * scale);
  const q = `[out:json][timeout:55];
    nwr(around:${wide},${lat},${lng})["wikipedia"]["name"][~"^(tourism|historic|amenity|leisure|man_made|natural|building|place|waterway|office)$"~"."]->.famous;
    nwr(around:${near},${lat},${lng})["amenity"~"^(restaurant|cafe|biergarten|ice_cream|fast_food|bar|pub)$"]["name"]->.food;
    (nwr(around:${wide},${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["name"];
     nwr(around:${wide},${lat},${lng})["historic"~"^(castle|monument|ruins|fort|palace|church|city_gate|archaeological_site)$"]["name"];)->.sights;
    .famous out center tags 600;
    .sights out center tags 400;
    .food out center tags 300;`;
  const r = await query(q);
  // Too heavy for the servers (a capital): the same, in a smaller circle, is better than nothing.
  if (r === "timeout") return scale === 1 ? overpassAround(lat, lng, 0.6) : [];
  return r;
}

/** Asks the servers, two rounds over all of them (busy servers often answer a little later). "timeout" when the
 *  query was too heavy for them; throws when none answered. An empty answer counts as a failure (`allowEmpty` not). */
async function query(q: string, allowEmpty = false): Promise<OsmElement[] | "timeout"> {
  let lastErr: unknown, timedOut = false;
  for (let round = 0; round < 2; round++) {
    if (round) await sleep(10000);
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(65000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { elements?: OsmElement[]; remark?: string };
        // A query the server gave up on comes back as a normal answer with a remark and nothing in it: not a list of
        // places (a big city would otherwise be "empty" for 30 days).
        if (body.remark && /timed out|runtime error|too busy|rate_limited/i.test(body.remark)) { timedOut = true; throw new Error(body.remark); }
        if (!body.elements?.length && !allowEmpty) throw new Error("empty answer");
        return body.elements || [];
      } catch (e) { lastErr = e; }
    }
    if (timedOut) return "timeout";
  }
  throw lastErr;
}

/** Places of the kinds the travelers asked for, around a point: a wider circle than the sights (a lighthouse is
 *  rarely in town), and the rare kinds wider still. Each element is marked with the kind it was found for. */
async function wishedAround(lat: number, lng: number, kinds: string[]): Promise<{ elements: OsmElement[]; complete: boolean }> {
  const sets = kinds.filter((k) => WANT_KINDS[k]).map((k) => {
    const { filters, rare } = WANT_KINDS[k], r = rare ? 40000 : 20000;
    return `(${filters.map((f) => `nwr(around:${r},${lat},${lng})${f}["name"];`).join("")})->.k_${k}; .k_${k} out center tags 60;`;
  });
  if (!sets.length) return { elements: [], complete: true };
  // One request per kind: the answer doesn't say which filter matched, so each kind's places are read apart.
  const out: OsmElement[] = [];
  let complete = true;
  for (const [i, set] of sets.entries()) {
    const r = await query(`[out:json][timeout:40];${set}`, true);
    if (r === "timeout") { complete = false; continue; }
    for (const e of r) out.push({ ...e, tags: { ...(e.tags || {}), __want: kinds.filter((k) => WANT_KINDS[k])[i] } });
  }
  return { elements: out, complete };
}

/** Fetched only once even when the background warm-up and a generation ask at the same time. */
const inflight = new Map<string, Promise<OsmElement[]>>();

export async function nearbyElements(city: string, cc?: string, onStatus: (s: string) => void = () => {}): Promise<OsmElement[] | null> {
  const town = await locateTown(city, cc);
  if (!town) return null;
  // "+2": lists fetched with the wider set of famous sights (older cached ones, "+" and without, lack some).
  const base = `${town.lat.toFixed(3)},${town.lng.toFixed(3)}`, key = `${base}+2`;
  const hit = nearbyCache.data[key];
  // (An empty list kept from before this check was a failed query, not an empty town: fetched again.)
  if (hit && hit.elements.length && Date.now() - hit.at < 30 * 864e5) return hit.elements;
  onStatus(`Finding real places around ${city}…`);
  if (!inflight.has(key)) {
    inflight.set(key, overpassAround(town.lat, town.lng).then((els) => {
      const elements = els.map(({ lat, lon, center, tags }) => ({ lat, lon, center, tags }));
      nearbyCache.data[key] = { at: Date.now(), elements };
      nearbyCache.saveNow();
      return elements;
    }).finally(() => inflight.delete(key)));
  }
  // A list fetched before (older than 30 days, or without the famous sights) stands in when the servers are slow or
  // down; the new one is fetched on and used next time.
  const old = (hit?.elements.length ? hit : null) || nearbyCache.data[`${base}+`] || nearbyCache.data[base];
  if (!old?.elements.length) return inflight.get(key)!;
  return Promise.race([inflight.get(key)!.catch(() => old.elements), sleep(30000).then(() => old.elements)]);
}

const wishedCache = diskCache<{ at: number; elements: OsmElement[] }>("wished.json");

/** The places of the kinds asked for around a town (cached 30 days by town and kinds); null when the town isn't found. */
export async function wishedElements(city: string, cc: string | undefined, kinds: string[], onStatus: (s: string) => void = () => {}): Promise<OsmElement[] | null> {
  const town = await locateTown(city, cc);
  if (!town) return null;
  const key = `${town.lat.toFixed(3)},${town.lng.toFixed(3)}|${[...kinds].sort().join(",")}`;
  const hit = wishedCache.data[key];
  if (hit && Date.now() - hit.at < 30 * 864e5) return hit.elements;
  onStatus(`Looking for what you asked to see around ${city}…`);
  const found = await wishedAround(town.lat, town.lng, kinds);
  const elements = found.elements.map(({ lat, lon, center, tags }) => ({ lat, lon, center, tags }));
  // (A kind the servers gave up on isn't "none there" for 30 days: asked again next time.)
  if (found.complete) { wishedCache.data[key] = { at: Date.now(), elements }; wishedCache.saveNow(); }
  return elements;
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
