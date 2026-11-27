// Real places near each stay, handed to the model so it plans with places that exist (with exact coordinates)
// instead of inventing names.
import type { TripStay } from "../../shared/types";
import { errMsg, sleep } from "../config";
import { type OsmElement, nearbyElements, pool } from "./overpass";

export interface NearbyPlace { name: string; kind: string; extras: string[]; lat: number; lng: number; hours?: string; website?: string }
export interface NearbyList { city: string; sights: NearbyPlace[]; food: NearbyPlace[] }

const FOOD = ["restaurant", "cafe", "biergarten", "ice_cream", "fast_food", "bar", "pub"];

/** Tags that make a place a sight, whatever else it's filed as (a famous church is also a "place of worship"). */
const SIGHT_KINDS = ["museum", "castle", "palace", "attraction", "zoo", "aquarium"];
const SIGHTS = 30;

/** How well known a place is: famous ones carry their name in many languages. */
const names = (t: Record<string, string>) => Object.keys(t).filter((k) => k.startsWith("name:")).length;

/**
 * Two well-known sights, then a lesser-known one (no Wikipedia article, known in few languages), and so on, so the
 * landmarks and the hidden gems both make a list however long it's cut. Where one kind runs out the other fills up.
 */
function mixed<T extends { known: boolean }>(ranked: T[], n: number) {
  const known = ranked.filter((p) => p.known), gems = ranked.filter((p) => !p.known), out: T[] = [];
  while (out.length < n && (known.length || gems.length)) {
    const from = (out.length % 3 === 2 ? gems.length : !known.length) ? gems : known;
    out.push(from.shift()!);
  }
  return out;
}

/** The most useful places: well-known sights and hidden gems; for food, places matching the travelers' diet if they
 *  mention one. */
export function rankNearby(elements: OsmElement[], interests: string) {
  const diet = /vegan/i.test(interests) ? "diet:vegan" : /vegetarian/i.test(interests) ? "diet:vegetarian" : null;
  const gf = /gluten/i.test(interests);
  const seen = new Set<string>(), sights: (NearbyPlace & { score: number; fame: number; known: boolean })[] = [], food: typeof sights = [];
  for (const e of elements) {
    const t = e.tags || {}, c = e.center || e;
    // Some names carry the height ("Scheidegger Wasserfälle (695m)"), which reads like a distance in the plan.
    const name = String(t.name || "").replace(/\s*\(\s*\d[\d.,]*\s*m\s*\)\s*$/i, "").trim();
    if (!name || c.lat == null || seen.has(name)) continue;
    seen.add(name);
    const isFood = FOOD.includes(t.amenity);
    const kind = (!isFood && [t.tourism, t.historic].find((k) => SIGHT_KINDS.includes(k))) || t.amenity || t.tourism || t.historic || t.leisure || "place";
    const extras = [
      t.cuisine && t.cuisine.replace(/;/g, ", "),
      diet && /yes|only/.test(t[diet] || "") && (t[diet] === "only" ? "fully vegan/vegetarian" : "vegan/vegetarian options"),
      gf && /yes|only/.test(t["diet:gluten_free"] || "") && "gluten-free options",
    ].filter((x): x is string => !!x);
    let score = (t.wikidata || t.wikipedia ? 4 : 0) + (t.website ? 1 : 0) + (t.opening_hours ? 1 : 0);
    if (isFood) score += (t.amenity === "restaurant" || t.amenity === "cafe" ? 1 : 0) + (extras.some((x) => /options|fully/.test(x)) ? 5 : 0);
    else score += SIGHT_KINDS.includes(kind) ? 2 : 0;
    const fame = names(t);
    (isFood ? food : sights).push({
      name, kind: kind.replace(/_/g, " "), extras, lat: +c.lat.toFixed(5), lng: +(c.lon ?? 0).toFixed(5), score, fame,
      known: !!t.wikipedia || fame >= 8,
      ...(t.opening_hours ? { hours: String(t.opening_hours).slice(0, 120) } : {}),
      ...(/^https?:\/\//.test(t.website || t["contact:website"] || "") ? { website: String(t.website || t["contact:website"]).split(";")[0].trim() } : {}),
    });
  }
  const plain = (arr: typeof sights) => arr.map(({ score: _, fame: __, known: ___, ...p }) => p);
  // Sights: among the well-known the most famous first; among the others the best described.
  sights.sort((a, b) => Number(b.known) - Number(a.known) || (a.known ? b.fame - a.fame : 0) || b.score - a.score);
  food.sort((a, b) => b.score - a.score);
  return { sights: plain(mixed(sights, SIGHTS)), food: plain(food.slice(0, 30)) };
}

/** For each stay: { city, sights, food }. */
export async function nearbyPlaces(stays: TripStay[], interests: string, onStatus: (s: string) => void): Promise<NearbyList[]> {
  const named = stays.filter((s) => s.city);
  // Don't hold up planning forever: after ~100 s a town is planned without its list (the fetch carries on and is cached).
  const deadline = Date.now() + 100000;
  const lists = await pool(named, 2, async (s) => {
    try {
      const fetching = nearbyElements(s.city, s.cc, onStatus);
      fetching.catch((e) => console.error(`Nearby places for ${s.city} failed:`, errMsg(e)));
      const elements = await Promise.race([fetching, sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const)]);
      if (elements === "timeout") { console.log(`Nearby places for ${s.city} are taking long; planning without them for now.`); return null; }
      return elements ? { city: s.city, ...rankNearby(elements, interests) } : null;
    } catch { return null; }
  });
  return lists.filter((l): l is NearbyList => !!l);
}

/** Start fetching in the background, so a later generation doesn't have to wait. */
export function warmNearby(stays: TripStay[]) {
  const named = stays.filter((s) => s?.city).slice(0, 20);
  pool(named, 2, (s) => nearbyElements(s.city, s.cc).catch((e) => console.error(`Nearby places for ${s.city} failed:`, errMsg(e))));
  return named.length;
}
