// Where an itinerary stop is. Models' own coordinates are guesses (local models' especially can be kilometres off),
// so known places and a real lookup of the stop's name around the day's town win; the guess is a marked fallback.
import type { Day, GeoHit, ItineraryItem, Place, Poi } from "../../../shared/types";
import { session, state } from "../core/state";
import { geo, geoKey, geocode } from "./geocode";
import { addDays } from "../core/format";
import { type Loc, countryCodes, distKm, placeLoc, stayLoc, stayOn } from "./locate";

export const byTitleMap = () => new Map(session.places.map((p) => [p.title, p]));
export type ByTitle = Map<string, Place>;

/** The towns a day's city field names ("Kyoto / Nara"), without bracketed details such as an address. */
export const daySegments = (d: Day) => String(d.city || "").replace(/\s*\([^)]*\)/g, "")
  .split(/\s*(?:\/|,|→|->|–|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);

// Lookup results that can't be a sight, a town or a meal: a "Pilatus" employment office or aircraft factory, or a
// "Pilatusstrasse" when the stop is Mount Pilatus.
const JUNK_KIND = /^(employment_agency|industrial|office|company|commercial|retail|government|bus_stop|stop_position|parking|post_box|atm|vending_machine|residential|primary|secondary|tertiary|unclassified|service|trunk|motorway|living_street)$/;
const usable = (g: GeoHit | null | undefined): g is GeoHit => !!g && !JUNK_KIND.test(g.kind || "");

const dayTowns = (d: Day): Loc[] => daySegments(d).map((seg) => geo[geoKey(seg, countryCodes())]).filter(usable);

/** The point a day's stops are searched around: the day's own town (e.g. Venice on a day trip), else where you sleep. */
function dayHome(d: Day): Loc | null {
  const town = dayTowns(d)[0];
  if (town) return town;
  const stay = stayOn(d);
  return stay ? stayLoc(stay) : null;
}

/** Every stay a day touches: on a travel day both the one you leave and the one you arrive at (and any in between). */
const staysOn = (d: Day) => state.stays.filter((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0))
  .map(stayLoc).filter((l): l is GeoHit => !!l);

/** Where a day happens: the towns it names plus the stays it touches. */
function dayRefs(d: Day): Loc[] {
  return [...dayTowns(d), ...staysOn(d)];
}

/** The day's towns for messages: the ones it names, plus the stays it touches ("Lucerne / Bregenz"). */
export function dayWhere(d: Day) {
  const stays = state.stays.filter((s) => s.city && s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0)).map((s) => s.city);
  const names = [...daySegments(d), ...stays];
  return [...new Map(names.map((n) => [n.toLowerCase(), n])).values()].join(" / ");
}

/** On a travel day, is the point roughly on the way between the stays (a detour of at most ~20%)? */
function onTheDrive(loc: Loc, d: Day) {
  const s = staysOn(d);
  for (let i = 1; i < s.length; i++) {
    const ab = distKm(s[i - 1], s[i]);
    if (ab > 30 && distKm(s[i - 1], loc) + distKm(loc, s[i]) - ab <= Math.max(30, ab * 0.2)) return true;
  }
  return false;
}

// Does a lookup result really have the stop's name? Fuzzy search happily turns an invented "Gasthaus zur Linde"
// into some other inn in town, so require a distinctive word of the name (not "Gasthaus", "Café" or the town).
const GENERIC_WORDS = new Set(("gasthaus gasthof restaurant ristorante trattoria osteria cafe caffe bakery baeckerei backerei hotel pension bar pub "
  + "bistro kirche church chiesa park street strasse town walk trail tour old altstadt centre center city market markt house haus lunch dinner "
  + "mount mountain monte mont peak summit gipfel lake lago").split(" "));
const words = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
function sameName(query: string, hit: Loc & { names?: string[] }, d: Day) {
  const towns = new Set(daySegments(d).flatMap(words));
  const name = words(query.split(",")[0]).filter((w) => !GENERIC_WORDS.has(w));
  // "Mount Pilatus" on a "Luzern / Pilatus" day is all town words: then the town word is what must match.
  const key = name.some((w) => !towns.has(w)) ? name.filter((w) => !towns.has(w)) : name;
  const found = new Set([hit.name || String(hit.label || "").split(",")[0], ...(hit.names || [])].flatMap(words));
  return key.some((w) => found.has(w));
}

/** Stops like "Lunch", "To Shinjuku", "Arrival" or "Airport → hotel" aren't places a geocoder can find. */
const GENERIC_STOP = /^(to |back |lunch|dinner|breakfast|brunch|snack|check[- ]?(in|out)|free time|rest)|→|\b(arrival|departure|transfer)\b/i;
/** What to look a stop up as: its name (with the day's town unless the name already has one of the day's towns),
 *  plus the name in brackets, which often is the exact spot ("Mount Pilatus (Pilatus Kulm)"). */
function itemQueries(x: ItineraryItem, d: Day): string[] {
  const clean = (s: string) => s.replace(/\s*\([^)]*\)/g, "").replace(/^(lunch|dinner|breakfast|brunch|coffee|drinks)\s*(at|:|-)\s*/i, "").trim();
  const name = clean(String(x.place));
  if (!name || GENERIC_STOP.test(name)) return [];
  const segs = daySegments(d);
  const withTown = (n: string) => segs.length && !segs.some((s) => n.toLowerCase().includes(s.toLowerCase())) ? `${n}, ${segs[0]}` : n;
  const inner = String(x.place).match(/\(([^)]+)\)/)?.[1]?.trim();
  const alt = inner && /^\p{Lu}/u.test(inner) && !/\d/.test(inner) && inner.length <= 40 ? [withTown(inner)] : [];
  return [...new Set([withTown(name), ...alt])];
}
const nearOf = (home: Loc): [number, number] => [home.lat, home.lng];

/** The best lookup result for a stop: one with its name if any, else the first plausible one (fuzzy). */
function stopHit(x: ItineraryItem, d: Day): { g: GeoHit; same: boolean } | null {
  const home = dayHome(d);
  if (!home) return null;
  let fuzzy: GeoHit | null = null;
  for (const q of itemQueries(x, d)) {
    const g = geo[geoKey(q, countryCodes(), nearOf(home), true)];
    if (!usable(g) || distKm(g, home) >= 60) continue;
    if (sameName(q, g, d)) return { g, same: true };
    fuzzy ||= g;
  }
  return fuzzy ? { g: fuzzy, same: false } : null;
}

// Real places (from OpenStreetMap) the model was given for this itinerary, by normalized name.
const normName = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
let poiIndex = new Map<string, Poi[]>(), poiIndexOf: Poi[] | undefined;
/** Several stays can have a place of the same name; with a day given, the one nearest that day wins. */
export function poiFor(name: string, day?: Day): Poi | null {
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
  return refs.length > 0 && refs.every((r) => distKm(loc, r) > 80) && !onTheDrive(loc, d) ? refs[0] : null;
}

export function itemLoc(x: ItineraryItem, day: Day, byTitle: ByTitle): Loc | null {
  const p = byTitle.get(x.place);
  const known = p && placeLoc(p) ? { loc: placeLoc(p)!, where: p.address || "" } : null;
  const poi = !known && poiFor(x.place, day);
  const hit = known || (poi && { loc: { lat: poi.lat, lng: poi.lng }, where: poi.city || "" });
  const home = dayHome(day), found = stopHit(x, day);
  if (hit) {
    const ref = farFromDay(hit.loc, day);
    if (!ref) return hit.loc;
    // Maybe there really is one of that name near the day too.
    if (found?.same) return found.g;
    return { lat: ref.lat, lng: ref.lng, approx: true, elsewhere: hit.where || `${hit.loc.lat.toFixed(3)}, ${hit.loc.lng.toFixed(3)}` };
  }
  if (found?.same) return found.g;            // found the place itself
  const fuzzy: Loc | null = found?.g || null; // something else with a similar name
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

/** The OpenStreetMap place a stop is (same name and pinned on it), or null. */
export function exactPoi(x: ItineraryItem, d: Day, byTitle: ByTitle): Poi | null {
  const poi = poiFor(x.place, d);
  if (!poi) return null;
  const loc = itemLoc(x, d, byTitle);
  return loc && !loc.approx && distKm(loc, poi) <= 0.3 ? poi : null;
}

/** A stop's own website: from the OpenStreetMap place it was given, or from looking up its name (same place only). */
export function stopWebsite(x: ItineraryItem, d: Day, byTitle: ByTitle): string | undefined {
  const poi = exactPoi(x, d, byTitle);
  if (poi?.website) return poi.website;
  const found = stopHit(x, d), loc = itemLoc(x, d, byTitle);
  return found?.same && found.g.website && (!loc || distKm(loc, found.g) < 1) ? found.g.website : undefined;
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
      const listed = byTitle.get(x.place);
      const known = poiFor(x.place, d) || (listed && placeLoc(listed));
      // Paid places are looked up even when their spot is known, for their website (ticket links).
      const paid = Number(x.cost) > 0 || !!x.booking;
      const elsewhere = !!itemLoc(x, d, byTitle)?.elsewhere;
      if (!known || paid || elsewhere) {
        // Stops whose spot is already known (looked up only for their website) wait behind the ones still to place.
        for (const q of itemQueries(x, d)) qs.push({ q, cc: countryCodes(), near: nearOf(home), first: !known || elsewhere, stop: true });
      }
    }
  }
  geocode(qs);
}
