// Real places near each stay, handed to the model so it plans with places that exist (with exact coordinates)
// instead of inventing names: the well-known sights (and hidden gems, as the travelers prefer), restaurants that suit
// their diet, and the kinds of place they asked for (a lighthouse, thermal baths), looked for farther out.
import type { TripStay } from "../../shared/types";
import { errMsg, sleep } from "../config";
import { type OsmElement, nearbyElements, pool, wishedElements } from "./overpass";
import { DIET_LABEL, type Prefs, prefsFromWords, type Want, WANT_KINDS } from "./prefs";

export interface NearbyPlace { name: string; kind: string; extras: string[]; lat: number; lng: number; hours?: string; website?: string; /** The travelers' words this was looked for by ("a lighthouse"). */ for?: string }
export interface NearbyList { city: string; sights: NearbyPlace[]; food: NearbyPlace[]; /** Places of the kinds they asked for, farther out than the sights. */ wished?: NearbyPlace[] }

const FOOD = ["restaurant", "cafe", "biergarten", "ice_cream", "fast_food", "bar", "pub"];

/** Tags that make a place a sight, whatever else it's filed as (a famous church is also a "place of worship"). */
const SIGHT_KINDS = ["museum", "castle", "palace", "attraction", "zoo", "aquarium"];
/** What a visitor goes to see, by tag: the kind the place is listed as, or null for anything else with an article
 *  (a district, a street, a school). Checked in order, so a famous church is a "church", not a "place of worship". */
const SIGHT_TAGS: [string, RegExp, ((v: string, t: Record<string, string>) => string) | undefined][] = [
  ["tourism", /^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium|artwork)$/, undefined],
  ["historic", /^(castle|monument|ruins|fort|palace|church|city_gate|archaeological_site|memorial|monastery|tower|aqueduct|mine|wayside_shrine|building|manor|citadel|fortification|cathedral|synagogue|mosque)$/, undefined],
  ["building", /^(cathedral|church|palace|castle|parliament|government|synagogue|mosque|temple|monastery|basilica|chapel)$/, undefined],
  ["amenity", /^(public_bath|marketplace|theatre|place_of_worship|townhall|parliament|library|fountain|monastery|planetarium)$/, (v, t) => (v === "place_of_worship" ? (t.religion === "christian" ? "church" : `${t.religion || "place"} of worship`) : v)],
  ["leisure", /^(park|garden|nature_reserve|marina|stadium)$/, undefined],
  ["man_made", /^(bridge|tower|lighthouse|windmill|observatory)$/, undefined],
  ["place", /^square$/, undefined],
  ["natural", /^(beach|peak|cave_entrance|hot_spring|water)$/, (v, t) => (v === "water" ? t.water || "water" : v)],
  ["waterway", /^waterfall$/, undefined],
  ["office", /^government$/, (_v, t) => t.government || "government building"],
  ["boundary", /^national_park$/, undefined],
];
function sightKind(t: Record<string, string>): string | null {
  for (const [key, re, name] of SIGHT_TAGS) {
    const v = t[key];
    if (v && re.test(v)) return name ? name(v, t) : v;
  }
  return null;
}
const SIGHTS = 30;

/** How well known a place is: famous ones carry their name in many languages. */
const names = (t: Record<string, string>) => Object.keys(t).filter((k) => k.startsWith("name:")).length;

/**
 * Well-known sights and lesser-known ones (no Wikipedia article, known in few languages) interleaved as the travelers
 * prefer: two landmarks then a gem (mixed), landmarks only (popular; gems fill up when few are known), or two gems
 * then a landmark (hidden), so both make a list however long it's cut. Where one kind runs out the other fills up.
 */
export function mixed<T extends { known: boolean }>(ranked: T[], n: number, mix: Prefs["placeMix"] = "mixed") {
  const known = ranked.filter((p) => p.known), gems = ranked.filter((p) => !p.known), out: T[] = [];
  const gemAt = (i: number) => (mix === "popular" ? false : mix === "hidden" ? i % 3 !== 2 : i % 3 === 2);
  while (out.length < n && (known.length || gems.length)) {
    const from = (gemAt(out.length) ? gems.length : !known.length) ? gems : known;
    out.push(from.shift()!);
  }
  return out;
}

/** The place as the model sees it, from an OpenStreetMap element; null when it has no name or place. */
function placeOf(e: OsmElement, prefs: Prefs) {
  const t = e.tags || {}, c = e.center || e;
  // Some names carry the height ("Scheidegger Wasserfälle (695m)"), which reads like a distance in the plan.
  const name = String(t.name || "").replace(/\s*\(\s*\d[\d.,]*\s*m\s*\)\s*$/i, "").trim();
  if (!name || c.lat == null) return null;
  const isFood = FOOD.includes(t.amenity);
  const sight = isFood ? null : (([t.tourism, t.historic].find((k) => SIGHT_KINDS.includes(k))) || sightKind(t) || (t.__want ? t.__want.replace(/_/g, " ") : null));
  if (!isFood && !sight) return null; // an article about a street, a district or a school isn't a place to go to
  const kind = sight || t.amenity;
  // Which of their diets the place is known to cater for ("fully vegan" when it serves nothing else).
  const diets = prefs.diet.filter((d) => /yes|only/.test(t[`diet:${d}`] || ""));
  const extras = [
    t.cuisine && t.cuisine.replace(/;/g, ", "),
    ...diets.map((d) => (t[`diet:${d}`] === "only" ? `fully ${DIET_LABEL[d]}` : `${DIET_LABEL[d]} options`)),
  ].filter((x): x is string => !!x);
  let score = (t.wikidata || t.wikipedia ? 4 : 0) + (t.website ? 1 : 0) + (t.opening_hours ? 1 : 0);
  // Food that suits every diet they named comes first, then food that suits some.
  if (isFood) score += (t.amenity === "restaurant" || t.amenity === "cafe" ? 1 : 0) + (diets.length ? 3 + (diets.length === prefs.diet.length ? 3 : 0) : 0);
  else score += SIGHT_KINDS.includes(kind) ? 2 : 0;
  const fame = names(t);
  return {
    isFood, score, fame, known: !!t.wikipedia || fame >= 8,
    place: {
      name, kind: kind.replace(/_/g, " "), extras, lat: +c.lat.toFixed(5), lng: +(c.lon ?? 0).toFixed(5),
      ...(t.opening_hours ? { hours: String(t.opening_hours).slice(0, 120) } : {}),
      ...(/^https?:\/\//.test(t.website || t["contact:website"] || "") ? { website: String(t.website || t["contact:website"]).split(";")[0].trim() } : {}),
    } as NearbyPlace,
  };
}

/** The most useful places: sights as the travelers like them; for food, places suiting their diet first. The
 *  preferences may still be the raw interests text (older callers): then the words decide. */
export function rankNearby(elements: OsmElement[], prefs: string | Prefs) {
  const p = typeof prefs === "string" ? prefsFromWords(prefs) : prefs;
  const seen = new Set<string>(), sights: NonNullable<ReturnType<typeof placeOf>>[] = [], food: typeof sights = [];
  for (const e of elements) {
    const x = placeOf(e, p);
    if (!x || seen.has(x.place.name)) continue;
    seen.add(x.place.name);
    (x.isFood ? food : sights).push(x);
  }
  // Sights: among the well-known the most famous first; among the others the best described.
  sights.sort((a, b) => Number(b.known) - Number(a.known) || (a.known ? b.fame - a.fame : 0) || b.score - a.score);
  food.sort((a, b) => b.score - a.score);
  return { sights: mixed(sights, SIGHTS, p.placeMix).map((x) => x.place), food: food.slice(0, 30).map((x) => x.place) };
}

/** The places of the kinds they asked for, a few of each kind, the well-known first. */
export function rankWished(elements: OsmElement[], wants: Want[], prefs: Prefs): NearbyPlace[] {
  const out: NearbyPlace[] = [], seen = new Set<string>();
  for (const w of wants) {
    const k = WANT_KINDS[w.kind];
    if (!k) continue;
    const ofKind = elements.filter((e) => e.tags?.__want === w.kind).map((e) => placeOf(e, prefs)).filter((x): x is NonNullable<typeof x> => !!x && !seen.has(x.place.name));
    ofKind.sort((a, b) => Number(b.known) - Number(a.known) || b.fame - a.fame || b.score - a.score);
    for (const x of ofKind.slice(0, 5)) { seen.add(x.place.name); out.push({ ...x.place, kind: k.label, for: w.what }); }
  }
  return out;
}

const townWord = (s: string) => s.toLowerCase().split(",")[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Whether a wish's "where" ("Budapest", "the Croatian coast") means this stay's town: its name is in it, or it in the name. */
export function wantsHere(where: string, city: string) {
  const w = townWord(where), c = townWord(city);
  if (!w || !c) return false;
  return w === c || w.includes(c) || c.includes(w) || where.toLowerCase().includes(city.toLowerCase().split(",").slice(-1)[0].trim());
}

/** For each stay: { city, sights, food, wished }. */
export async function nearbyPlaces(stays: TripStay[], prefs: string | Prefs, onStatus: (s: string) => void): Promise<NearbyList[]> {
  const p = typeof prefs === "string" ? prefsFromWords(prefs) : prefs;
  const named = stays.filter((s) => s.city);
  // Don't hold up planning forever: after ~100 s a town is planned without its list (the fetch carries on and is cached).
  const deadline = Date.now() + 100000;
  const lists = await pool(named, 2, async (s) => {
    try {
      const fetching = nearbyElements(s.city, s.cc, onStatus);
      fetching.catch((e) => console.error(`Nearby places for ${s.city} failed:`, errMsg(e)));
      // What they asked for, around stays they sleep at (a town passed through gets no day to see it): a wish for a
      // town is looked for there only, one without a town around every stay. Fetched alongside the sights, with
      // time of its own (the sights may have used up the deadline).
      const wants = Number(s.nights) > 0 ? p.wants.filter((w) => !w.where || wantsHere(w.where, s.city)) : [];
      const wishing = wants.length ? wishedElements(s.city, s.cc, [...new Set(wants.map((w) => w.kind))], onStatus).catch((e) => { console.error(`What they asked for around ${s.city} failed:`, errMsg(e)); return null; }) : Promise.resolve(null);
      const elements = await Promise.race([fetching, sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const)]);
      if (elements === "timeout") { console.log(`Nearby places for ${s.city} are taking long; planning without them for now.`); return null; }
      if (!elements) return null;
      const list: NearbyList = { city: s.city, ...rankNearby(elements, p) };
      const wished = await Promise.race([wishing, sleep(Math.max(15000, deadline - Date.now())).then(() => null)]);
      if (wished?.length) list.wished = rankWished(wished, wants, p);
      return list;
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
