// "McDonald's in this area", like a maps app's search for a chain or a kind of place, in the map's view. Two parts:
// names (and brands) from Photon, which answers at once ("mcdonalds" finds every McDonald's, "ramen" the places with
// ramen in their name); and, for everyday words, the kind of place itself from OpenStreetMap through Overpass ("konbini"
// or "atm" finds every one, whatever it's called). The public Overpass servers can be slow or busy, so the page shows
// the names first and adds the rest when (and if) they come. Both kept for 10 minutes.
import type { GeoHit } from "../../shared/types";
import { USER_AGENT } from "../config";
import { OVERPASS } from "../trip/overpass";
import { photon, photonHit } from "./providers";

/** Where the map shows: south, west, north, east. */
export type Box = [number, number, number, number];

/** Everyday words and the kinds of place they mean (Overpass tag filters). */
const KINDS: [RegExp, string[]][] = [
  [/^(cafes?|coffee( shops?)?|kissaten)$/, ['["amenity"="cafe"]']],
  [/^(restaurants?|places to eat)$/, ['["amenity"="restaurant"]']],
  [/^(fast food|takeaway|take away)$/, ['["amenity"="fast_food"]']],
  [/^(bars?|pubs?|izakayas?)$/, ['["amenity"~"^(bar|pub)$"]', '["cuisine"~"izakaya"]']],
  [/^(atms?|cash( machines?)?|cash points?)$/, ['["amenity"="atm"]', '["atm"="yes"]']],
  [/^(pharmac(y|ies)|drug ?stores?|chemists?)$/, ['["amenity"="pharmacy"]', '["shop"="chemist"]']],
  [/^(supermarkets?|grocer(y|ies))$/, ['["shop"="supermarket"]']],
  [/^(convenience( stores?)?|konbini|kombini|corner shops?)$/, ['["shop"="convenience"]']],
  [/^(hotels?|hostels?|accommodation|places to stay)$/, ['["tourism"~"^(hotel|hostel|guest_house|motel)$"]']],
  [/^(toilets?|restrooms?|wc|bathrooms?|loos?)$/, ['["amenity"="toilets"]']],
  [/^(parking|car parks?|parking lots?)$/, ['["amenity"="parking"]']],
  [/^(train stations?|stations?|railway stations?)$/, ['["railway"="station"]']],
  [/^(metro|subway)( stations?)?$/, ['["station"="subway"]']],
  [/^(bus stops?|bus stations?)$/, ['["highway"="bus_stop"]', '["amenity"="bus_station"]']],
  [/^(bakery|bakeries)$/, ['["shop"="bakery"]']],
  [/^(post offices?)$/, ['["amenity"="post_office"]']],
  [/^(laundr(y|ies)|laundromats?|coin laundry)$/, ['["shop"~"^(laundry|dry_cleaning)$"]']],
  [/^(museums?)$/, ['["tourism"="museum"]']],
  [/^(parks?)$/, ['["leisure"="park"]']],
  [/^(temples?)$/, ['["amenity"="place_of_worship"]["religion"="buddhist"]']],
  [/^(shrines?)$/, ['["amenity"="place_of_worship"]["religion"="shinto"]']],
  [/^(churches?)$/, ['["amenity"="place_of_worship"]["religion"="christian"]']],
  [/^(petrol|gas|fuel)( stations?)?$/, ['["amenity"="fuel"]']],
  [/^(ev )?charg(ers?|ing( stations?)?)$/, ['["amenity"="charging_station"]']],
  [/^(ice cream|gelato)$/, ['["amenity"="ice_cream"]', '["cuisine"~"ice_cream"]']],
  [/^(viewpoints?)$/, ['["tourism"="viewpoint"]']],
  [/^(onsens?|hot springs?|bath ?houses?|sentos?)$/, ['["amenity"="public_bath"]', '["natural"="hot_spring"]']],
];
/** Dishes: the kind of food as well as the name ("ramen" also finds the ramen shops called something else). */
const CUISINES = ["ramen", "sushi", "pizza", "burger", "curry", "udon", "soba", "tempura", "yakitori", "okonomiyaki", "takoyaki", "gyoza", "tonkatsu", "kebab", "tacos", "noodle", "steak", "vegan", "vegetarian", "indian", "thai", "chinese", "korean", "italian", "french", "mexican"];

const word = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/** The tag filters an everyday word means (none for a name). */
export function kindFilters(q: string): string[] {
  const w = word(q), out: string[] = [];
  for (const [re, filters] of KINDS) if (re.test(w)) out.push(...filters);
  const dish = CUISINES.find((c) => w === c || w === `${c}s` || w === `${c} restaurant` || w === `${c} restaurants`);
  if (dish) out.push(`["cuisine"~"${dish}",i]`);
  return out;
}

/** The Overpass query for the kinds of place an everyday word means, in a box ("" when it means none). */
export function kindQuery(q: string, box: Box, limit = 200): string {
  const filters = kindFilters(q);
  if (!filters.length) return "";
  const bbox = box.map((n) => n.toFixed(5)).join(",");
  return `[out:json][timeout:20];(${filters.map((f) => `nwr${f}(${bbox});`).join("")});out center tags ${limit};`;
}

function checkBox(box: Box) {
  const [s, w, n, e] = box;
  if (!box.every(Number.isFinite) || s >= n || w >= e) throw new Error("Not an area on the map.");
  if (n - s > 0.6 || e - w > 0.8) throw new Error("Zoom in a little to search this area (it's too big to search at once).");
}

const cache = new Map<string, { at: number; hits: GeoHit[] }>();
async function kept(key: string, get: () => Promise<GeoHit[]>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.hits;
  const hits = await get();
  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return hits;
}
const keyOf = (what: string, q: string, box: Box) => `${what}|${word(q)}|${box.map((x) => x.toFixed(3)).join(",")}`;

/** Places in the box whose name or brand matches (Photon: at once). */
export function searchAreaNames(q: string, box: Box): Promise<GeoHit[]> {
  checkBox(box);
  if (!word(q)) throw new Error("Type a name or a kind of place.");
  const [s, w, n, e] = box;
  return kept(keyOf("n", q, box), async () => {
    const params = new URLSearchParams({ q: word(q), bbox: [w, s, e, n].map((x) => x.toFixed(5)).join(","), limit: "50", lang: "en" });
    return (await photon(params)).map(photonHit).filter((h) => h.name);
  });
}

/** Places in the box of the kind an everyday word means (Overpass: may take a while, or fail when it's busy); [] for a
 *  word that isn't a kind of place. */
export function searchAreaKinds(q: string, box: Box): Promise<GeoHit[]> {
  checkBox(box);
  const query = kindQuery(q, box);
  if (!query) return Promise.resolve([]);
  return kept(keyOf("k", q, box), async () => {
    let lastErr: unknown;
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return ((((await res.json()) as any).elements || []) as any[]).map(osmHit).filter((h): h is GeoHit => !!h);
      } catch (e) { lastErr = e; }
    }
    throw new Error(`The map's servers for kinds of place are busy (${(lastErr as Error)?.message || "no answer"}).`);
  });
}

/** A place from OpenStreetMap as a search result: its English name where it has one, with the local one. */
function osmHit(el: any): GeoHit | null {
  const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  const local = t.name || "", en = t["name:en"] || t["brand:en"] || "";
  const kind = t.amenity || t.shop || t.tourism || t.railway || t.leisure || t.historic || t.highway || "";
  const name = en || local || t.brand || "";
  if (!name && !kind) return null;
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const label = [name || kind.replace(/_/g, " "), en && local && en !== local ? local : "", street, t["addr:city"] || t["addr:suburb"] || ""].filter(Boolean).join(", ");
  return { lat, lng, name: name || kind.replace(/_/g, " ").replace(/^./, (c: string) => c.toUpperCase()), label, country: "", cc: "", kind };
}
