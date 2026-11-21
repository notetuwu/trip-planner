// Where an itinerary stop is. Models' own coordinates are guesses (local models' especially can be kilometres off),
// so known places and a real lookup of the stop's name around the day's town win; the guess is a marked fallback.
import type { Day, GeoHit, ItineraryItem, Place, Poi } from "../../../shared/types";
import { session, state } from "../core/state";
import { geo, geoKey, geocode } from "./geocode";
import { type Loc, countryCodes, distKm, placeLoc, stayLoc, stayOn } from "./locate";

export const byTitleMap = () => new Map(session.places.map((p) => [p.title, p]));
export type ByTitle = Map<string, Place>;

/** The towns a day's city field names ("Kyoto / Nara"). */
export const daySegments = (d: Day) => String(d.city || "").split(/\s*(?:\/|,|→|->|–|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
const dayTowns = (d: Day): Loc[] => daySegments(d).map((seg) => geo[geoKey(seg, countryCodes())]).filter((g): g is GeoHit => !!g);

/** The point a day's stops are searched around: the day's own town (e.g. Venice on a day trip), else where you sleep. */
function dayHome(d: Day): Loc | null {
  const town = dayTowns(d)[0];
  if (town) return town;
  const stay = stayOn(d);
  return stay ? stayLoc(stay) : null;
}

/** Where a day happens: the towns it names plus where you sleep that night. */
function dayRefs(d: Day): Loc[] {
  const stay = stayOn(d);
  const here = stay ? stayLoc(stay) : null;
  return here ? [...dayTowns(d), here] : dayTowns(d);
}

// Does a lookup result really have the stop's name? Fuzzy search happily turns an invented "Gasthaus zur Linde"
// into some other inn in town, so require a distinctive word of the name (not "Gasthaus", "Café" or the town).
const GENERIC_WORDS = new Set("gasthaus gasthof restaurant ristorante trattoria osteria cafe caffe bakery baeckerei backerei hotel pension bar pub bistro kirche church chiesa park street strasse town walk trail tour old altstadt centre center city market markt house haus lunch dinner".split(" "));
const words = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
function sameName(query: string, hit: Loc, d: Day) {
  const towns = new Set(daySegments(d).flatMap(words));
  const key = words(query.split(",")[0]).filter((w) => !GENERIC_WORDS.has(w) && !towns.has(w));
  const found = new Set(words(hit.name || String(hit.label || "").split(",")[0]));
  return key.some((w) => found.has(w));
}

/** Stops like "Lunch", "To Shinjuku", "Arrival" or "Airport → hotel" aren't places a geocoder can find. */
const GENERIC_STOP = /^(to |back |lunch|dinner|breakfast|brunch|snack|check[- ]?(in|out)|free time|rest)|→|\b(arrival|departure|transfer)\b/i;
function itemQuery(x: ItineraryItem, d: Day) {
  const name = String(x.place).replace(/\s*\([^)]*\)/g, "").replace(/^(lunch|dinner|breakfast|brunch|coffee|drinks)\s*(at|:|-)\s*/i, "").trim();
  if (!name || GENERIC_STOP.test(name)) return null;
  const town = daySegments(d)[0];
  return town && !name.toLowerCase().includes(town.toLowerCase()) ? `${name}, ${town}` : name;
}
const nearOf = (home: Loc): [number, number] => [home.lat, home.lng];

// Real places (from OpenStreetMap) the model was given for this itinerary, by normalized name.
const normName = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
let poiIndex = new Map<string, Poi[]>(), poiIndexOf: Poi[] | undefined;
/** Several stays can have a place of the same name; with a day given, the one nearest that day wins. */
function poiFor(name: string, day?: Day): Poi | null {
  const pois = state.meta?.pois;
  if (pois !== poiIndexOf) {
    poiIndexOf = pois; poiIndex = new Map();
    for (const p of pois || []) { const k = normName(p.name); if (!poiIndex.has(k)) poiIndex.set(k, []); poiIndex.get(k)!.push(p); }
  }
  const hits = poiIndex.get(normName(name));
  if (!hits) return null;
  const refs = day ? dayRefs(day) : [];
  if (!refs.length) return hits[0];
  const dist = (p: Poi) => Math.min(...refs.map((r) => distKm(p, r)));
  return hits.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

/** A known place nowhere near the day (e.g. a Padua café the model put on a Munich day) is a mix-up: returns the
 *  day's town, where it gets pinned as approximate instead of drawing an 850 km leg. */
function farFromDay(loc: Loc, d: Day) {
  const refs = dayRefs(d);
  return refs.length > 0 && refs.every((r) => distKm(loc, r) > 80) ? refs[0] : null;
}

export function itemLoc(x: ItineraryItem, day: Day, byTitle: ByTitle): Loc | null {
  const p = byTitle.get(x.place);
  const known = p && placeLoc(p) ? { loc: placeLoc(p)!, where: p.address || "" } : null;
  const poi = !known && poiFor(x.place, day);
  const hit = known || (poi && { loc: { lat: poi.lat, lng: poi.lng }, where: poi.city || "" });
  const home = dayHome(day), q = itemQuery(x, day);
  const g = q && home ? geo[geoKey(q, countryCodes(), nearOf(home))] : null;
  if (hit) {
    const ref = farFromDay(hit.loc, day);
    if (!ref) return hit.loc;
    // Maybe there really is one of that name near the day too.
    if (g && home && distKm(g, home) < 60 && sameName(q!, g, day)) return g;
    return { lat: ref.lat, lng: ref.lng, approx: true, elsewhere: hit.where || `${hit.loc.lat.toFixed(3)}, ${hit.loc.lng.toFixed(3)}` };
  }
  let fuzzy: Loc | null = null;
  if (g && home && distKm(g, home) < 60) {
    if (sameName(q!, g, day)) return g; // found the place itself
    fuzzy = g;                           // something else with a similar name
  }
  const model = typeof x.lat === "number" && typeof x.lng === "number" ? { lat: x.lat, lng: x.lng } : null;
  // Check guesses against the towns the day names, or (until those are located) where you sleep that night.
  const towns = dayTowns(day);
  const refs: Loc[] = towns.length ? towns : home ? [home] : [];
  const inTown = (l: Loc) => !refs.length || refs.some((t) => distKm(l, t) < 8);
  if (model && inTown(model)) return { ...model, approx: true };
  if (fuzzy && inTown(fuzzy)) return { ...fuzzy, approx: true };
  // The model's guess is far from every town the day names (e.g. a whole day shifted 15 km): put it in the day's town.
  if (model && refs.length) return { lat: refs[0].lat, lng: refs[0].lng, approx: true };
  if (model) return { ...model, approx: true };
  return fuzzy ? { ...fuzzy, approx: true } : null;
}

/** Looks up the itinerary's towns, then its stops around them (only what isn't known or looked up yet). */
export function geocodeItems() {
  const it = state.itinerary; if (!it || !countryCodes()) return;
  const byTitle = byTitleMap(), qs = [];
  for (const d of it.days) {
    for (const seg of daySegments(d)) qs.push({ q: seg, cc: countryCodes(), first: true });
    const home = dayHome(d);
    if (!home) continue;
    for (const x of d.items) {
      const q = itemQuery(x, d);
      const listed = byTitle.get(x.place);
      const known = poiFor(x.place, d) || (listed && placeLoc(listed));
      if (q && (itemLoc(x, d, byTitle)?.elsewhere || !known)) qs.push({ q, cc: countryCodes(), near: nearOf(home), first: true });
    }
  }
  geocode(qs);
}
