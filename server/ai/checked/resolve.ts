// Where every stop of a plan is, worked out in code from its name: the travelers' saved places, the real places from
// OpenStreetMap the model was given, the stay for hotel stops, a transfer's destination, and otherwise a lookup of the
// name around the town the day is in. Nothing comes from the model's idea of coordinates (a town's middle for every
// stop, an invented street), so the checks measure real distances and the map pins what was planned.
import type { Day, ItineraryItem, Place } from "../../../shared/types";
import type { GeoHit } from "../../../shared/geo";
import { km } from "../../../shared/route";
import type { NearbyList } from "../../trip/nearby";
import type { Frame } from "./frames";
import { GENERIC_DEST, GENERIC_MEAL, GENERIC_WORDS, isCheckIn, isCheckOut, isHotelStop, isRide, isTransfer, lc, mealSpot, MEAL_WORD, nameParts, namedMeal, names, norm, short, transferEnds, words } from "./text";

/** A lookup: a stop's name around a town ("stop"), or a town by its name ("town"). Null when nothing is found. */
export type GeoFn = (q: string, cc: string | undefined, near: [number, number] | null, kind: "stop" | "town") => Promise<GeoHit | null>;

export interface Town { name: string; lat: number; lng: number; cc?: string }
export type How = "saved" | "poi" | "stay" | "fixed" | "geocoded" | "near";
/** Where a stop is and how that was found; "near": only roughly (a meal near a named spot), not shown as exact. */
export interface Spot { lat: number; lng: number; how: How; name: string; hours?: string; cc?: string; /** What kind of place it is, when OpenStreetMap says ("museum", "public bath"). */ kind?: string; /** Only the town's middle (a meal that says no more than the town). */ rough?: boolean }
export type Located = Map<string, Spot>;
export const spotKey = (date: string, i: number) => `${date}#${i}`;

export interface ResolveInput {
  frames: Frame[];
  stays: { city: string; lat?: number; lng?: number; cc?: string; hotel?: string; dayTrips?: { place: string }[] }[];
  saved: Place[];
  nearby: NearbyList[];
  /** Country codes of the trip ("at,hu,hr"), for lookups. */
  countries: string;
  geo: GeoFn;
}

const at = (p?: { lat?: number; lng?: number } | null): p is { lat: number; lng: number } => typeof p?.lat === "number" && typeof p?.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng);
/** How far a stop of a town may be from the town's point to count as found there. */
const TOWN_REACH_KM = 60;
/** How far a ride out of a town of the day can go (a ferry to an island, a train to the next city). */
const RIDE_REACH_KM = 150;
/** A transfer's destination or a day-trip town can't be farther from the day than this. */
const DAY_REACH_KM = 300;

/** A found place really has the stop's name: a distinctive word of the name (not "museum", "square" or the town) is in the hit's names. */
export function sameName(query: string, hit: Pick<GeoHit, "name" | "label" | "names">, townWords: Set<string> = new Set(), inTown = false, searched: Set<string> = townWords) {
  const raw = words(query.split(",")[0]);
  const found = new Set([hit.name || "", String(hit.label || "").split(",")[0], ...(hit.names || [])].flatMap(words));
  const distinct = raw.filter((w) => !GENERIC_WORDS.has(w) && !townWords.has(w));
  // A longer word may be inflected differently in the local name ("Prešeren" / "Prešernov", "Marin Držić" /
  // "Marina Držića"): the stem counts.
  const stem = (w: string) => (w.length >= 5 ? w.slice(0, 5) : w);
  const stems = new Set([...found].map(stem));
  if (distinct.length) {
    const matched = distinct.filter((w) => found.has(w) || (w.length >= 5 && stems.has(stem(w))));
    // Most of the real words, and among them a substantial one ("Sea Organ" isn't the "Californian sea lion").
    return matched.length >= Math.ceil(distinct.length / 2) && (matched.length === distinct.length || matched.some((w) => w.length >= 5));
  }
  // Only generic words left ("Old Town Square"): all of them must be there, and the town too when the name had it,
  // unless the place found is right in that town ("Split Port" isn't any port 50 km away; "Dubrovnik City Walls" is
  // the "City Walls" a kilometre from Dubrovnik's centre).
  const generic = raw.filter((w) => !townWords.has(w)), town = raw.filter((w) => townWords.has(w));
  return generic.length > 0 && generic.every((w) => found.has(w)) && (!town.length || town.some((w) => found.has(w)) || (inTown && town.some((w) => searched.has(w))));
}

/** The towns a day happens in, in the order the day goes: where they wake up, the stops on the way, where they arrive. */
export function dayTowns(f: Frame, i: number, frames: Frame[], stays: ResolveInput["stays"]): Town[] {
  const out: Town[] = [];
  const add = (name: string, p?: { lat?: number; lng?: number; cc?: string } | null) => {
    if (!at(p) || out.some((t) => lc(short(t.name)) === lc(short(name)))) return;
    out.push({ name, lat: p.lat, lng: p.lng, cc: (p as { cc?: string }).cc });
  };
  const wake = i > 0 ? frames[i - 1].sleep : null;
  if (wake) add(stays[wake.idx].city, stays[wake.idx]);
  for (const l of f.legs) {
    add(stays[l.fromIdx].city, stays[l.fromIdx]);
    for (const s of l.stops) add(s.name, s);
    add(stays[l.toIdx].city, stays[l.toIdx]);
  }
  if (f.sleep) add(stays[f.sleep.idx].city, stays[f.sleep.idx]);
  return out;
}

const SETTLEMENT = /^(city|town|village|hamlet|suburb|quarter|neighbourhood|locality|administrative|municipality|borough|district|island|county|state|region)$/;

/**
 * Locates the stops of these days in place: lat/lng and `fixed` on the ones found for certain, lat/lng alone on rough
 * ones (a meal near a named spot). Whatever location the model wrote is dropped first. Returns where each stop is, by
 * `${date}#${index}`, and notes on what was renamed.
 */
export async function resolveDays(days: Day[], input: ResolveInput, located: Located = new Map()): Promise<{ located: Located; notes: string[] }> {
  const notes: string[] = [];
  const byDate = new Map(input.frames.map((f, i) => [f.date, i]));
  const savedExact = new Map(input.saved.map((p) => [lc(p.title), p]));
  // A saved place under a slightly different name ("Chamonix" for "Chamonix, France"): most words of each in the
  // other, and at least one of them a real name, not "bridge" or "museum" ("Chain Bridge" isn't "Pelješac Bridge").
  const distinctShared = (a: string, b: string) => { const w = new Set(words(b.split(",")[0])); return words(a.split(",")[0]).some((x) => !GENERIC_WORDS.has(x) && w.has(x)); };
  const savedNamed = (name: string): Place | null => {
    const n = lc(name).trim();
    const exact = savedExact.get(n) || savedExact.get(lc(namedMeal(name)));
    if (exact) return exact;
    const hits = input.saved.filter((p) => names(name, p.title) && names(p.title, name) && distinctShared(name, p.title));
    return hits.length === 1 ? hits[0] : null;
  };
  const stayNamed = (name: string) => input.stays.find((s) => at(s) && (lc(s.city) === lc(name) || lc(short(s.city)) === lc(short(name)))) || null;
  const townCache = new Map<string, Town | null>();
  const townLookup = async (name: string, refs: Town[]): Promise<Town | null> => {
    const key = lc(name);
    if (!townCache.has(key)) {
      const hit = await input.geo(name, input.countries || undefined, null, "town").catch(() => null);
      const ok = hit && (SETTLEMENT.test(hit.kind || "") || sameName(name, hit)) && (!refs.length || refs.some((t) => km(t, hit) <= DAY_REACH_KM));
      townCache.set(key, ok ? { name, lat: hit.lat, lng: hit.lng, cc: hit.cc } : null);
    }
    return townCache.get(key) || null;
  };

  for (const d of days) {
    const fi = byDate.get(d.date);
    if (fi == null) continue;
    const f = input.frames[fi];
    const towns = dayTowns(f, fi, input.frames, input.stays);
    // Day trips planned from this stay are towns of the day too (Hvar on a Split day).
    const sleep = f.sleep ? input.stays[f.sleep.idx] : null;
    if (f.kind === "full" && sleep) for (const t of sleep.dayTrips || []) { if (t.place) { const town = await townLookup(t.place, towns); if (town) towns.push(town); } }
    if (!towns.length) continue;
    const wake = fi > 0 && input.frames[fi - 1].sleep ? input.stays[input.frames[fi - 1].sleep!.idx] : f.legs[0] ? input.stays[f.legs[0].fromIdx] : sleep;
    const arrive = f.legs.length ? input.stays[f.legs[f.legs.length - 1].toIdx] : sleep;
    const pois = input.nearby.filter((n) => towns.some((t) => lc(short(t.name)) === lc(short(n.city)))).flatMap((n) => [...n.sights, ...n.food, ...(n.wished || [])]);
    const townWords = new Set(towns.flatMap((t) => words(short(t.name))));
    const poiNamed = (name: string, here: { lat: number; lng: number }) => {
      const n = norm(name), m = norm(namedMeal(name) || "");
      const hits = pois.filter((p) => { const pn = norm(p.name); return pn && (pn === n || pn === m || (pn.length >= 6 && pn.includes(" ") && ` ${n} `.includes(` ${pn} `))); });
      return hits.sort((a, b) => km(a, here) - km(b, here))[0] || null;
    };
    let current = 0;
    const rideTowns = new Set<number>();
    let here: { lat: number; lng: number } = towns[0];
    // Whether "here" is only roughly known (a ride found as the whole island it goes to, a meal somewhere in town).
    let hereRough = false;
    const isTownName = (s: string) => towns.some((t) => lc(short(t.name)) === lc(short(s)) || lc(short(t.name)) === lc(s.replace(/^the\s+/i, "")));
    /** How far from the stop before a place can be, by how they get there: a walk of a few minutes isn't 30 km. */
    const reachOf = (x?: ItineraryItem) => {
      const t = x?.transport || "", m = /(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*min)?|(\d+)\s*min/i.exec(t);
      const mins = m ? (m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] || 0)) : 0;
      if (/\b(walk|walking|on foot|stroll)\b/i.test(t) && !/\b(drive|car|bus|tram|metro|train|ferry|taxi)\b/i.test(t)) return Math.max(2, (mins || 15) * 0.1);
      if (/\b(metro|tram|bus|subway|u-?bahn|s-?bahn|funicular|cable ?car|lift)\b/i.test(t) && mins && mins <= 45) return Math.max(8, mins * 1.2);
      if (/\b(taxi|drive|driving|car|uber)\b/i.test(t) && mins && mins <= 60) return Math.max(10, mins * 1.3 + 5);
      return Infinity;
    };
    /** A restaurant or café by its name: a village that shares the name ("Rukavac" for "Konoba Rukavac") isn't it. */
    const EATERY = /^(konoba|restaurant|ristorante|restoran|trattoria|osteria|gostilna|gasthaus|gasthof|caf[ée]|caffè|kavarna|kavana|bistro|pizzeria|wirtshaus|brasserie|taverna|tavern|bar|pub|vegetari\p{L}+|vegan\p{L}*)(?![\p{L}])/iu;
    const SETTLEMENT = /^(city|town|village|hamlet|suburb|locality|island|islet|administrative|municipality|county|state|neighbourhood|quarter|isolated_dwelling|farm|postcode|street|road)$/i;
    const geocodeNear = async (name: string, here: { lat: number; lng: number }, reach = Infinity, eatery = EATERY.test(name)): Promise<Spot | null> => {
      if (!name || isTownName(name)) return null;
      // The town the day has got to first, then the others by distance; a name that carries one of the day's towns
      // ("Ljubljana Old Town") is looked up in that town only (Split has an old town too).
      const order = [towns[current], ...towns.filter((t) => t !== towns[current]).sort((a, b) => km(a, here) - km(b, here))].slice(0, 3);
      for (const part of nameParts(name)) {
        if (isTownName(part) || words(part).length === 0) continue;
        const named = towns.find((t) => lc(part).includes(lc(short(t.name))));
        // Around where they are, too, when that's away from the town's middle (Hvar town, not the island's centre).
        const spots = (named ? [named] : order).flatMap((t) => (!hereRough && km(here, t) > 3 && km(here, t) < 40 ? [t, { ...t, lat: here.lat, lng: here.lng }] : [t]));
        for (const town of spots) {
          const cc = [...new Set([...(input.countries || "").split(",").filter(Boolean), lc(town.cc || "")].filter(Boolean))].join(",");
          const tw = short(town.name);
          // "Dubrovnik City Walls": as written, then "City Walls, Dubrovnik" (how the page looks it up, and how the
          // geocoder knows it); "City Walls": with the town added.
          const bare = lc(part).includes(lc(tw)) ? part.replace(new RegExp(`\\b${tw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").replace(/\s{2,}/g, " ").replace(/^[\s,'-]+|[\s,'-]+$/g, "").trim() : "";
          const queries = lc(part).includes(lc(tw)) ? [part, ...(words(bare).length ? [`${bare}, ${tw}`] : [])] : [`${part}, ${tw}`];
          for (const q of queries) {
            const hit = await input.geo(q, cc || undefined, [town.lat, town.lng], "stop").catch(() => null);
            if (!hit || km(hit, town) >= TOWN_REACH_KM || !sameName(part, hit, townWords, km(hit, town) < 5, new Set(words(short(town.name))))) continue;
            if (eatery && SETTLEMENT.test(hit.kind || "")) continue;
            // Farther than the walk from the stop before allows, and away from every town the day is still in or going
            // to: another place of the name (a church 30 km up the coast, a café back in the town they left this
            // morning); in such a town it stands, the walk being the model's error.
            if (!named && !hereRough && km(hit, here) > reach && towns.every((t, k) => (k < current && !rideTowns.has(k)) || km(hit, t) > 10)) continue;
            // A name that carries the town, found much nearer to another town of the day: that town's place, not this
            // one's (the cathedral of Split for "Hvar Cathedral"). A name without a town may be anywhere the day goes.
            if (named && towns.some((t) => t !== town && km(hit, t) < km(hit, town) / 2)) continue;
            return { lat: hit.lat, lng: hit.lng, how: "geocoded", name: hit.name || part, cc: hit.cc };
          }
        }
      }
      return null;
    };
    const stayOf = (s: typeof wake): Spot | null => (s && at(s) ? { lat: s.lat, lng: s.lng, how: "stay", name: s.hotel || short(s.city), cc: s.cc } : null);
    const findPlace = async (raw: string, here: { lat: number; lng: number }, mark?: ItineraryItem, reach = reachOf(mark)): Promise<Spot | null> => {
      // "Dubrovnik: Old Town Walls": the town is a prefix, not part of the name.
      const name = raw.replace(/^([^:]{2,40}):\s+/, (m, t) => (isTownName(t) ? "" : m));
      const p = savedNamed(name);
      // A saved place of that name far from everywhere the day goes (a "Chain Bridge" in another country's list) is
      // another place of the same name: looked up here instead.
      if (p && (!at(p) || towns.some((t) => km(t, p) <= TOWN_REACH_KM))) {
        if (mark) { if (lc(p.title) !== lc(name)) notes.push(`"${name}" is your saved "${p.title}".`); mark.fromList = true; }
        if (at(p)) return { lat: p.lat, lng: p.lng, how: "saved", name: p.title };
      }
      const poi = poiNamed(name, here);
      if (poi && !(!hereRough && km(poi, here) > reach && km(poi, towns[current]) > 10)) return { lat: poi.lat, lng: poi.lng, how: "poi", name: poi.name, hours: poi.hours, kind: poi.kind };
      return geocodeNear(name, here, reach, mark?.kind === "meal" || EATERY.test(name));
    };

    // Which of the day's towns the plan has got to: on from the start when a stop's own transport is a long drive or
    // ride, or when a stop turns out to be in a later town; hotel stops and lookups go by it.
    const nearestTown = (p: { lat: number; lng: number }) => towns.reduce((b, t, i) => (km(t, p) < km(towns[b], p) ? i : b), 0);
    const inArrival = () => !!arrive && at(arrive) && km(towns[current], arrive) < 20;
    const movedOn = (x: ItineraryItem) => {
      const t = x.transport || "", m = /(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*min)?|(\d+)\s*min/i.exec(t);
      const mins = m ? (m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] || 0)) : 0;
      return mins >= 40 && /\b(drive|driving|car|train|bus|coach|ferry|boat|flight)\b/i.test(t);
    };
    for (let i = 0; i < d.items.length; i++) {
      const x = d.items[i], key = spotKey(d.date, i);
      located.delete(key);
      if (movedOn(x) && current < towns.length - 1) { current++; here = towns[current]; }
      delete x.where;
      const keep = (x.pinned || x.fixed) && at(x);
      if (!keep) { delete x.lat; delete x.lng; delete x.fixed; }
      let spot: Spot | null = null;
      if (keep) spot = { lat: x.lat!, lng: x.lng!, how: "fixed", name: x.place };
      else if (isTransfer(x)) {
        const dest = transferEnds(x.place)?.[1] || /\bto\s+([^,()]+?)\s*$/i.exec(x.place.replace(/\s*\([^)]*\)/g, ""))?.[1] || "";
        const stay = dest ? stayNamed(dest) : null;
        if (stay) spot = stayOf(stay);
        else if (dest && /\b(hotel|accommodation|home)\b/i.test(dest) && GENERIC_DEST.test(dest.trim())) spot = stayOf(inArrival() ? arrive : wake);
        else if (dest && GENERIC_DEST.test(dest.trim())) spot = await geocodeNear(dest, here); // "Old Port": only around the town they're in
        else if (dest) {
          const way = f.legs.flatMap((l) => l.stops).find((s) => at(s) && (names(dest, s.name) || names(s.name, dest)));
          const p = way ? null : savedNamed(dest);
          const town = way || (p && at(p) ? p : null) || (await townLookup(dest, towns));
          // A town of that name on the other side of the country ("Upper Lakes" in Hungary for a shuttle in Plitvice) isn't it.
          if (town && at(town) && towns.some((t) => km(t, town) <= RIDE_REACH_KM)) spot = { lat: town.lat, lng: town.lng, how: way || p ? "saved" : "geocoded", name: dest };
          // A ride to somewhere that isn't one of the day's towns (the ferry to Hvar from Split): the day goes on
          // there, so the stops after it are looked up around it, not around the town the ride left.
          if (spot && isRide(x) && towns.every((t) => km(t, spot!) > 10)) { towns.push({ name: dest, lat: spot.lat, lng: spot.lng, cc: spot.cc }); current = towns.length - 1; rideTowns.add(current); }
        } else if (!GENERIC_DEST.test(x.place.replace(/\s*\([^)]*\)/g, "").trim())) {
          spot = await geocodeNear(x.place, here); // "Split Riva Ferry Terminal": a place of its own
        }
      } else if (isHotelStop(x) && !savedExact.has(lc(x.place))) {
        const checkIn = isCheckIn(x.place), out = isCheckOut(x.place) || /breakfast/i.test(x.place);
        spot = stayOf(checkIn || (inArrival() && !out) ? arrive : wake);
      } else if ((MEAL_WORD.test(x.place) || GENERIC_MEAL.test(x.place)) && !namedMeal(x.place)) {
        // "Lunch near the Great Market Hall": roughly at the hall; "Dinner in Zagreb", "Lunch": roughly in the town
        // they're in (so the day's timeline can be checked), not pinned.
        const nearWhat = mealSpot(x.place);
        const s = nearWhat && !isTownName(nearWhat) ? await findPlace(nearWhat, here, undefined, reachOf(x)) : null;
        const town = towns[current];
        spot = s ? { ...s, how: "near" } : town ? { lat: km(here, town) < 30 ? here.lat : town.lat, lng: km(here, town) < 30 ? here.lng : town.lng, how: "near", name: short(town.name), rough: true } : null;
      } else {
        spot = await findPlace(x.place, here, x);
      }
      if (!spot) continue;
      located.set(key, spot);
      if (spot.hours) located.get(key)!.hours = spot.hours;
      x.lat = spot.lat; x.lng = spot.lng;
      if (spot.how === "near") delete x.fixed; else x.fixed = true;
      here = spot; hereRough = !!spot.rough || (isTransfer(x) && spot.how === "geocoded");
      const ni = nearestTown(spot);
      // On to a later town of the day; back only on a spot that's certain (the stay the ferry lands at, a saved or
      // listed place), not on a lookup that may have found the wrong town; always to and from a ride's town.
      if (km(towns[ni], spot) < 30 && (ni > current || spot.how !== "geocoded" || rideTowns.has(ni) || rideTowns.has(current))) current = ni;
    }
    // A ride found only as the whole place it goes to (the island of Hvar, its middle) lands where the day goes on:
    // the first stop after it that was found, when that is near.
    for (let i = 0; i < d.items.length; i++) {
      const x = d.items[i], s = located.get(spotKey(d.date, i));
      if (!s || !isRide(x) || s.how !== "geocoded") continue;
      const next = d.items.slice(i + 1).map((y, j) => ({ y, s: located.get(spotKey(d.date, i + 1 + j)) })).find((o) => o.s && !isTransfer(o.y) && o.s.how !== "near");
      if (next && km(next.s!, s) < 25 && km(next.s!, s) > 0.5) { s.lat = next.s!.lat; s.lng = next.s!.lng; x.lat = s.lat; x.lng = s.lng; }
    }
  }
  return { located, notes };
}
