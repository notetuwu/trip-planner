// Where an itinerary stop is. Models' own coordinates are guesses (local models' especially can be kilometres off),
// so known places and a real lookup of the stop's name around the day's town win; the guess is a marked fallback.
import type { Day, GeoHit, ItineraryItem, Place, Poi } from "../../../shared/types";
import { session, state } from "../core/state";
import { geo, geoKey, geocode } from "./geocode";
import { addDays } from "../core/format";
import { type Loc, countryCodes, distKm, placeLoc, stayLoc, stayOn } from "./locate";
import { onWayOf, splitGroup, transferEnds } from "../trip/modes";
import { activityTown } from "./stop-text";
import { namesRide } from "../itinerary/journey-model";
import { pointUrl, searchUrl } from "../core/maps-links";

export { activityTown };

export const byTitleMap = () => new Map(session.places.map((p) => [p.title, p]));
export type ByTitle = Map<string, Place>;

/** The towns a day's city field names ("Kyoto / Nara"), without bracketed details such as an address. */
export const daySegments = (d: Day) => String(d.city || "").replace(/\s*\(\s*via\s+([^)]*)\)/gi, " / $1").replace(/\s*\([^)]*\)/g, "")
  .split(/\s*(?:\/|,|→|->|–|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);

// Lookup results that can't be a sight, a town or a meal: a "Pilatus" employment office or aircraft factory, or a
// "Pilatusstrasse" when the stop is Mount Pilatus.
const JUNK_KIND = /^(employment_agency|industrial|office|company|commercial|retail|government|bus_stop|stop_position|parking|post_box|atm|vending_machine|residential|primary|secondary|tertiary|unclassified|service|trunk|motorway|living_street)$/;
const usable = (g: GeoHit | null | undefined): g is GeoHit => !!g && !JUNK_KIND.test(g.kind || "");

/** A town of the day, looked up both within the trip's countries and anywhere: Vaduz is in Liechtenstein even when
 *  nobody sleeps there (searched only in the stays' countries, "Vaduz" came back as something in Sardinia). Of the
 *  two, the one nearer the day's stays wins. */
function townHit(seg: string, d: Day): GeoHit | null {
  const found = [geo[geoKey(seg, countryCodes())], geo[geoKey(seg)]].filter(usable);
  if (found.length < 2) return found[0] || null;
  const refs = staysOn(d);
  if (!refs.length) return found[0];
  const dist = (g: GeoHit) => Math.min(...refs.map((r) => distKm(g, r)));
  return dist(found[1]) < dist(found[0]) - 1 ? found[1] : found[0];
}
/** Both lookups of a town (see townHit). */
const townQueries = (q: string) => [{ q, cc: countryCodes(), first: true }, { q, first: true }];

const dayTowns = (d: Day): Loc[] => daySegments(d).map((seg) => townHit(seg, d)).filter((g): g is GeoHit => !!g);

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

/** On a full day of a stay, the places of its day trips (Hiroshima from Osaka): stops there aren't in the wrong town. */
const dayTripsOn = (d: Day) => state.stays.filter((s) => s.start && d.date > s.start && d.date < addDays(s.start, Number(s.nights) || 0))
  .flatMap((s) => (s.dayTrips || []).filter((t) => t.place).map((t) => geo[geoKey(t.place)])).filter(usable);

/** Where a day happens: the towns it names, the stays it touches and their day trips. */
function dayRefs(d: Day): Loc[] {
  return [...dayTowns(d), ...staysOn(d), ...dayTripsOn(d)];
}

interface Town { name: string; loc: Loc }
/** The towns a day can happen in: those its city names ("Osaka / Onomichi / Hiroshima") and its stay's day trips. */
function townList(d: Day): Town[] {
  const out: Town[] = [];
  for (const seg of daySegments(d)) { const g = townHit(seg, d); if (g) out.push({ name: seg, loc: g }); }
  for (const s of state.stays) if (s.start && d.date > s.start && d.date < addDays(s.start, Number(s.nights) || 0))
    for (const t of s.dayTrips || []) { const g = t.place ? geo[geoKey(t.place)] : null; if (usable(g)) out.push({ name: t.place, loc: g }); }
  return out;
}
const bare = (name: string) => name.split(",")[0].trim().toLowerCase();
const count = (text: string, name: string) => { const n = bare(name); return n ? text.split(n).length - 1 : 0; };

/** Where the plan has got to by this stop: the town of the last transfer before it ("Osaka → Kyoto" puts the next
 *  stops in Kyoto, "Kyoto → Osaka" back in Osaka), following only the stop's own group on a split day. */
function townSoFar(x: ItineraryItem, d: Day, towns: Town[]): Town | null {
  const g = splitGroup(x);
  let at: Town | null = null;
  for (const y of d.items) {
    if (y === x) return at;
    if (!onWayOf(d.items, y, g)) continue;
    const ends = transferEnds(y);
    if (!ends) continue;
    const to = bare(ends[1]);
    const named = towns.find((t) => bare(t.name) && (to.includes(bare(t.name)) || bare(t.name).includes(to)));
    if (named) { at = named; continue; }
    // A station or spot rather than a town ("Saga-Arashiyama Station"): where it is, named after the nearest of the
    // day's towns for lookups ("…, Kyoto").
    const spot = townHit(cleanDest(ends[1]), d);
    if (spot && typeof spot.lat === "number") { // any result will do here, even the bus stop outside the station
      const near = towns.reduce<Town | null>((b, t) => (!b || distKm(t.loc, spot) < distKm(b.loc, spot) ? t : b), null);
      at = { name: near && distKm(near.loc, spot) < 40 ? near.name : ends[1], loc: spot };
    }
  }
  return at;
}

/** A transfer's destination for looking it up: without "(JR)" and the like. */
const cleanDest = (s: string) => s.replace(/\s*\([^)]*\)/g, "").trim();

/** Where a stop is looked for: the town its name mentions ("Lunch in Onomichi"); else where the day's transfers have
 *  taken it (Kyoto after "Osaka → Kyoto"); for a split group's stop, the town that group spends the day in (Miyajima
 *  on the Hiroshima group's day); else the day's own town or the stay. */
function itemTown(x: ItineraryItem, d: Day): Town | null {
  const towns = townList(d), name = String(x.place).toLowerCase();
  const own = towns.find((t) => bare(t.name) && name.includes(bare(t.name)));
  if (own) return own;
  const sofar = townSoFar(x, d, towns);
  if (sofar) return sofar;
  const g = splitGroup(x);
  if (g) {
    const stays = state.stays.filter((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0)).map((s) => bare(s.city));
    const text = d.items.filter((y) => splitGroup(y) === g && y.kind !== "transfer").map((y) => `${y.place} ${y.description || ""} ${y.transport || ""}`).join(" ").toLowerCase();
    let best: Town | null = null, most = 0;
    for (const t of towns) { if (stays.includes(bare(t.name))) continue; const n = count(text, t.name); if (n > most) { best = t; most = n; } }
    if (best) return best;
  }
  const home = dayHome(d);
  return home ? { name: daySegments(d)[0] || "", loc: home } : null;
}

/**
 * The town to search a stop by in a maps app: the one of the day's towns nearest to where it is (within ~25 km), else
 * the stop's own town. "The Raum" alone is anywhere; "The Raum, Innsbruck" is the one. "" when its name already says
 * it ("Lunch in Vaduz") or there is none.
 */
export function stopTown(x: ItineraryItem, d: Day, loc?: Loc | null): string {
  const towns = townList(d), name = String(x.place).toLowerCase();
  const near = loc ? towns.reduce<Town | null>((b, t) => (distKm(t.loc, loc) < 25 && (!b || distKm(t.loc, loc) < distKm(b.loc, loc)) ? t : b), null) : null;
  const own = near || itemTown(x, d);
  // Somewhere far from all of them (a stop on a long drive): no town, rather than the wrong one.
  if (!own || (loc && distKm(own.loc, loc) > 25)) return "";
  const short = own.name.split(",")[0].trim();
  return short && !name.includes(short.toLowerCase()) ? short : "";
}

/** A stop in the maps app: searched by name and town, so it opens the place itself (its page, hours, reviews) rather
 *  than a bare pin at its coordinates; only a place far from every town of the day, where a name search could find
 *  another of that name, gets the pin. */
export function stopMapsUrl(x: ItineraryItem, d: Day, loc: Loc | null) {
  const name = x.place.replace(/\s*\([^)]*\)/g, "").trim(), exact = loc && !loc.approx ? loc : null;
  // Not located (yet): the day's first town, as the plan names it.
  const first = (daySegments(d)[0] || "").split(",")[0].trim();
  const town = stopTown(x, d, exact) || (!exact && first && !name.toLowerCase().includes(first.toLowerCase()) ? first : "");
  if (!town && exact) return pointUrl(exact, name);
  return searchUrl(town ? `${name}, ${town}` : name, loc);
}

/** Hotel stops ("Hotel breakfast", "Check-in", "Back to the hotel"): at the hotel, as located for the stay. */
const HOTEL_STOP = /^(hotel\b|breakfast at (the )?hotel|check[- ]?(in|out)\b)|\b(at|back to|return to) (the )?hotel\b/i;
function hotelLoc(x: ItineraryItem, d: Day): Loc | null {
  if (!HOTEL_STOP.test(String(x.place))) return null;
  const on = state.stays.filter((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0));
  // Check-in is at the stay you arrive at; breakfast and check-out at the one you wake up in. On a travel day, any other
  // hotel stop after checking in, arriving or one of the day's rides ("Rest at the hotel" at 17:00) is at the new one.
  const before = d.items.slice(0, Math.max(0, d.items.indexOf(x)));
  const arrived = !/check[- ]?out|checkout|breakfast/i.test(x.place)
    && before.some((y) => /check[- ]?in|checkin|\barriv/i.test(y.place) || y.kind === "transfer" || !!transferEnds(y) || namesRide(y));
  const stay = /check[- ]?in/i.test(x.place) || arrived ? on.at(-1) : on.find((s) => s.start < d.date) || on.at(-1);
  return stay ? stayLoc(stay) : null;
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
function itemQueries(x: ItineraryItem, d: Day, town = daySegments(d)[0] || ""): string[] {
  const clean = (s: string) => s.replace(/\s*\([^)]*\)/g, "").replace(/^(lunch|dinner|breakfast|brunch|coffee|drinks)\s*(at|:|-)\s*/i, "").trim();
  const name = clean(String(x.place));
  if (!name || GENERIC_STOP.test(name)) return [];
  const segs = daySegments(d);
  const withTown = (n: string) => town && !segs.some((s) => n.toLowerCase().includes(s.toLowerCase())) && !n.toLowerCase().includes(bare(town)) ? `${n}, ${town}` : n;
  const inner = String(x.place).match(/\(([^)]+)\)/)?.[1]?.trim();
  const alt = inner && /^\p{Lu}/u.test(inner) && !/\d/.test(inner) && inner.length <= 40 ? [withTown(inner)] : [];
  return [...new Set([withTown(name), ...alt])];
}
const nearOf = (home: Loc): [number, number] => [home.lat, home.lng];
/** What to look a stop's "where" up as: as written (with the town when it names none of the day's), then just the venue's
 *  name (before the first comma) with the town, as a full address is often not found. */
function whereQueries(x: ItineraryItem, d: Day, town: string): string[] {
  const w = String(x.where || "").trim();
  if (!w) return [];
  const segs = daySegments(d), has = (s: string) => segs.some((t) => s.toLowerCase().includes(t.toLowerCase())) || (!!town && s.toLowerCase().includes(bare(town)));
  const withTown = (s: string) => (town && !has(s) ? `${s}, ${town}` : s);
  const venue = w.split(",")[0].trim();
  return [...new Set([withTown(w), ...(venue && venue !== w && !/^\d/.test(venue) ? [withTown(venue)] : [])])];
}
/** The stop's "where", found on the map near its town: given on purpose, so taken as it is (it needn't share the name). */
function whereHit(x: ItineraryItem, d: Day): GeoHit | null {
  const town = itemTown(x, d), home = town?.loc;
  if (!home) return null;
  for (const q of whereQueries(x, d, town!.name)) {
    const g = geo[geoKey(q, stopCc(town!), nearOf(home), true)];
    if (usable(g) && distKm(g, home) < 60) return g;
  }
  return null;
}
/** The countries a stop is searched in: the trip's, plus the country of the town it's in (Liechtenstein for a stop in
 *  Vaduz on a drive from Germany to Switzerland). */
const stopCc = (town: Town) => [...new Set([...countryCodes().split(","), town.loc.cc || ""].filter(Boolean))].join(",");

/** The day's towns other than the one a stop is searched around first (at most three, more than ~10 km away). */
const otherTowns = (d: Day, town: Town) => townList(d).filter((t) => bare(t.name) !== bare(town.name) && distKm(t.loc, town.loc) > 10).slice(0, 3);
/** Settlements and districts: what an activity's town lookup may land on (not a bar called "Sunset"). */
const SETTLEMENT = /^(city|town|village|hamlet|suburb|quarter|neighbourhood|isolated_dwelling|locality|administrative|municipality|borough|district)$/;

/** The best lookup result for a stop: one with its name if any, else the first plausible one (fuzzy). */
function stopHit(x: ItineraryItem, d: Day): { g: GeoHit; same: boolean; town?: boolean } | null {
  const town = itemTown(x, d), home = town?.loc;
  if (!home) return null;
  const cc = stopCc(town!);
  let fuzzy: GeoHit | null = null;
  for (const q of itemQueries(x, d, town!.name)) {
    const g = geo[geoKey(q, cc, nearOf(home), true)];
    if (!usable(g) || distKm(g, home) >= 60) continue;
    if (sameName(q, g, d)) return { g, same: true };
    fuzzy ||= g;
  }
  // A day through several towns (Isny → Vaduz → Lucerne): the place may be at another of them.
  for (const t of otherTowns(d, town!)) {
    for (const q of itemQueries(x, d, t.name)) {
      const g = geo[geoKey(q, stopCc(t), nearOf(t.loc), true)];
      if (usable(g) && distKm(g, t.loc) < 60 && sameName(q, g, d)) return { g, same: true };
    }
  }
  // "Kempten old town walk" on a Isny day: the walk is in Kempten, so it goes there (the town's own point).
  const at = activityTown(x.place);
  if (at && !daySegments(d).some((s) => bare(s) === at.toLowerCase())) {
    const g = geo[geoKey(at, cc, nearOf(home), true)];
    if (usable(g) && SETTLEMENT.test(g.kind || "") && distKm(g, home) < 60 && sameName(at, g, { ...d, city: "" })) return { g, same: false, town: true };
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
  // Set by the travelers themselves: that's where it is.
  if (x.pinned && typeof x.lat === "number" && typeof x.lng === "number") return { lat: x.lat, lng: x.lng };
  // Looked up from its address (a booking, a stop added in the chat): that's where it is, unless the lookup found a
  // place of that name far from everywhere the day goes (a "Gasthaus Muster" near Bayreuth on a day by Bregenz). Then
  // one near the day, if there is one; otherwise the day's town, marked as elsewhere so the check flags it.
  if (x.fixed && typeof x.lat === "number" && typeof x.lng === "number") {
    const at = { lat: x.lat, lng: x.lng }, ref = farFromDay(at, day);
    if (!ref) return at;
    const near = stopHit(x, day);
    if (near?.same) return near.g;
    return { lat: ref.lat, lng: ref.lng, approx: true, elsewhere: `${at.lat.toFixed(3)}, ${at.lng.toFixed(3)}` };
  }
  // Where it says it is (the venue of an exhibition, the mall a shop is in).
  const where = x.where ? whereHit(x, day) : null;
  if (where) return where;
  const p = byTitle.get(x.place);
  const hotel = !p && hotelLoc(x, day);
  if (hotel) return hotel;
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
  if (found?.town) return { ...found.g, approx: true }; // a walk in a town the name gives: that town
  const fuzzy: Loc | null = found?.g || null; // something else with a similar name
  const model = typeof x.lat === "number" && typeof x.lng === "number" ? { lat: x.lat, lng: x.lng } : null;
  // Check guesses against the towns the day names, or (until those are located) where you sleep that night.
  const towns = [...dayTowns(day), ...dayTripsOn(day)];
  const refs: Loc[] = towns.length ? towns : home ? [home] : [];
  // Near one of the day's towns, or within reach of the stop's own town (Miyajima, 20 km from Hiroshima).
  const town = itemTown(x, day);
  const inTown = (l: Loc) => !refs.length || refs.some((t) => distKm(l, t) < 8) || (!!town && distKm(l, town.loc) < 30);
  if (model && inTown(model)) return { ...model, approx: true };
  if (fuzzy && inTown(fuzzy)) return { ...fuzzy, approx: true };
  // The model's guess is far from everywhere the day goes (local models can be 70 km off): put it in the stop's own
  // town, not the day's first one.
  if (model && refs.length) { const at = town?.loc || refs[0]; return { lat: at.lat, lng: at.lng, approx: true }; }
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
    for (const seg of daySegments(d)) qs.push(...townQueries(seg));
    // Where transfers end (a station such as "Saga-Arashiyama Station"), so the stops after them are looked up there.
    for (const x of d.items) { const ends = transferEnds(x); if (ends) qs.push(...townQueries(cleanDest(ends[1]))); }
    for (const x of d.items) {
      const town = itemTown(x, d);
      if (!town) continue;
      for (const q of whereQueries(x, d, town.name)) qs.push({ q, cc: stopCc(town), near: nearOf(town.loc), first: true, stop: true });
      const listed = byTitle.get(x.place);
      const known = poiFor(x.place, d) || (listed && placeLoc(listed));
      // Paid places are looked up even when their spot is known, for their website (ticket links).
      const paid = Number(x.cost) > 0 || !!x.booking;
      const elsewhere = !!itemLoc(x, d, byTitle)?.elsewhere;
      if (!known || paid || elsewhere) {
        // Stops whose spot is already known (looked up only for their website) wait behind the ones still to place.
        for (const q of itemQueries(x, d, town.name)) qs.push({ q, cc: stopCc(town), near: nearOf(town.loc), first: !known || elsewhere, stop: true });
      }
      // Around the day's other towns too, after everything else (only needed when it isn't found at the first).
      if (!known) for (const t of otherTowns(d, town)) for (const q of itemQueries(x, d, t.name)) qs.push({ q, cc: stopCc(t), near: nearOf(t.loc), first: false, stop: true });
      const at = !known && activityTown(x.place);
      if (at) qs.push({ q: at, cc: stopCc(town), near: nearOf(town.loc), first: true, stop: true });
    }
  }
  geocode(qs);
}
