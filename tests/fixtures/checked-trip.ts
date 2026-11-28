// A made-up trip for the checked planner's tests: public towns only, invented holidays and events. It has the
// situations the planner must handle: a must-see stop on the way between two stays, a holiday in a country they
// aren't in yet, an event dated after they've left town, and a place to skip.
import { km } from "../../shared/route";
import type { GeoHit } from "../../shared/geo";
import type { Day, ItineraryItem, Place } from "../../shared/types";
import type { RouteFn } from "../../server/ai/checked/frames";
import type { GeoFn, Located } from "../../server/ai/checked/resolve";
import { spotKey } from "../../server/ai/checked/resolve";
import type { Trip } from "../../server/ai/types";

export const LYON = { lat: 45.764, lng: 4.8357 }, ANNECY = { lat: 45.8992, lng: 6.1294 }, TURIN = { lat: 45.0703, lng: 7.6869 };
export const GENOA = { lat: 44.4056, lng: 8.9463 }, CHAMONIX = { lat: 45.9237, lng: 6.8694 };

export function fixtureTrip(): Trip {
  return {
    stays: [
      { city: "Lyon, France", start: "2030-06-10", nights: 2, hotel: "", cc: "FR", ...LYON },
      { city: "Annecy, France", start: "2030-06-12", nights: 2, hotel: "", cc: "FR", travel: "car", ...ANNECY },
      { city: "Turin, Italy", start: "2030-06-14", nights: 3, hotel: "", cc: "IT", travel: "car", ...TURIN },
      { city: "Genoa, Italy", start: "2030-06-17", nights: 1, hotel: "", cc: "IT", travel: "car", ...GENOA },
    ],
    dailyBudget: 100, budgetPer: "person", currency: "EUR", travelers: 2, pace: "balanced (3-5 stops per day)", getAround: "car",
    interests: "", wishes: "", notes: "", model: "local|ollama|http://127.0.0.1:1|fake", list: "", research: false,
    mustSee: ["Chamonix, France"], mustSeeWho: {}, skip: ["Tourist Trap Museum"],
    mustSeeRoute: { "Chamonix, France": { how: "way", leg: { from: "Annecy, France", to: "Turin, Italy", date: "2030-06-14", detourKm: 40, legKm: 160 }, onWay: true } },
    holidays: [
      { date: "2030-06-13", name: "Invented Italian Day", cc: "IT" },
      { date: "2030-06-15", name: "Invented Regional Day", cc: "IT", counties: ["IT-21"] },
    ],
    drives: { 1: { km: 140, hours: 1.6 }, 2: { km: 210, hours: 2.6 }, 3: { km: 170, hours: 1.9 } },
    nearby: [
      { city: "Turin, Italy", sights: [{ name: "Museo Egizio", kind: "museum", extras: [], lat: 45.0685, lng: 7.6843, hours: "Tu-Su 09:00-18:30" }], food: [{ name: "Trattoria Valenza", kind: "restaurant", extras: [], lat: 45.0711, lng: 7.6902 }] },
    ],
  } as unknown as Trip;
}

export const fixturePlaces: Place[] = [
  { title: "Chamonix, France", lat: CHAMONIX.lat, lng: CHAMONIX.lng },
  { title: "Basilica of Fourvière", lat: 45.7623, lng: 4.8226 },
  { title: "Tourist Trap Museum", lat: 45.76, lng: 4.84 },
];

/** A fake routing service: straight-line km, a little longer, at 75 km/h. */
export const fakeRoute: RouteFn = async (a, b) => {
  if (typeof a.lat !== "number" || typeof b.lat !== "number") return undefined;
  const d = km(a as { lat: number; lng: number }, b as { lat: number; lng: number }) * 1.3;
  return { km: Math.round(d), hours: d / 75 };
};

/** A fake geocoder: finds any stop a little off the town it's searched around, under the name asked for; towns by a
 *  small gazetteer; nothing for names starting with "Unknown". */
export const fakeGeo: GeoFn = async (q, _cc, near, kind) => {
  const name = q.split(",")[0].trim();
  if (/^unknown/i.test(name)) return null;
  const towns: Record<string, { lat: number; lng: number }> = { lyon: LYON, annecy: ANNECY, turin: TURIN, genoa: GENOA, chamonix: CHAMONIX, portofino: { lat: 44.3036, lng: 9.2097 }, "isola bella": { lat: 45.89, lng: 8.52 }, faraway: { lat: 48.0, lng: 10.0 } };
  if (kind === "town") { const t = towns[name.toLowerCase()]; return t ? hit(name, t, "city") : null; }
  if (!near) return null;
  // "Elsewhere …" is found, but under another name (a stranger that shares no word).
  if (/^elsewhere/i.test(name)) return hit("Something Else Entirely", { lat: near[0] + 0.01, lng: near[1] + 0.01 }, "attraction");
  return hit(name, { lat: near[0] + 0.004, lng: near[1] + 0.004 }, "attraction");
};
const hit = (name: string, p: { lat: number; lng: number }, kind: string): GeoHit => ({ ...p, name, label: `${name}, Somewhere`, country: "", cc: "fr", kind });

/** A stop with everything filled in; the location is what the fixture's fake geocoder will find for it. */
export const stop = (time: string, place: string, kind: ItineraryItem["kind"], at: { lat: number; lng: number }, more: Partial<ItineraryItem> = {}): ItineraryItem => ({
  time, place, kind, description: "", durationMinutes: kind === "meal" ? 60 : kind === "transfer" ? 120 : 90, transport: "Walk, 10 min", cost: 20, costPer: "person",
  lat: at.lat + 0.002, lng: at.lng + 0.002, ...more,
});

/** Where the fixture's stops are, taken from the coordinates the fixture gave them (for checks without resolving). */
export function locate(days: Day[]): Located {
  const out: Located = new Map();
  for (const d of days) d.items.forEach((x, i) => { if (typeof x.lat === "number" && typeof x.lng === "number") out.set(spotKey(d.date, i), { lat: x.lat, lng: x.lng, how: "geocoded", name: x.place }); });
  return out;
}

/** A plain full day in a town: three sights, lunch and dinner, names unique to the date. */
export const fullDay = (date: string, city: string, at: { lat: number; lng: number }): Day => ({
  date, city, title: city, estimatedCost: 0, items: [
    stop("09:00", `Old Town walk ${date}`, "sight", at), stop("11:00", `Museum ${date}`, "sight", at),
    stop("12:30", `Trattoria ${date}`, "meal", at), stop("14:30", `Garden ${date}`, "sight", at), stop("19:00", `Bistro ${date}`, "meal", at),
  ],
});

/** A whole plan of the fixture trip that passes every check (the drives are in the first stop of each town). */
export function goodPlan(): Day[] {
  return [
    fullDay("2030-06-10", "Lyon", LYON),
    fullDay("2030-06-11", "Lyon", LYON),
    { date: "2030-06-12", city: "Lyon / Annecy", title: "", estimatedCost: 0, items: [stop("09:30", "Hotel check-out", "other", LYON, { durationMinutes: 15 }), stop("12:30", "Lunch 06-12", "meal", ANNECY, { transport: "Drive, 2 h 10 min" }), stop("14:00", "Hotel check-in", "other", ANNECY, { durationMinutes: 20 }), stop("15:00", "Lake walk 06-12", "sight", ANNECY), stop("19:00", "Dinner 06-12", "meal", ANNECY)] },
    fullDay("2030-06-13", "Annecy", ANNECY),
    { date: "2030-06-14", city: "Annecy / Chamonix / Turin", title: "", estimatedCost: 0, items: [
      stop("09:45", "Chamonix", "sight", CHAMONIX, { fromList: true, durationMinutes: 120, transport: "Drive, 1 h 05 min" }),
      stop("12:00", "Lunch in Chamonix 06-14", "meal", CHAMONIX), stop("16:00", "Hotel check-in Turin", "other", TURIN, { durationMinutes: 20, transport: "Drive, 2 h 30 min" }), stop("19:00", "Dinner 06-14", "meal", TURIN)] },
    fullDay("2030-06-15", "Turin", TURIN),
    fullDay("2030-06-16", "Turin", TURIN),
    { date: "2030-06-17", city: "Turin / Genoa", title: "", estimatedCost: 0, items: [stop("13:00", "Lunch 06-17", "meal", GENOA, { transport: "Drive, 2 h 30 min" }), stop("15:00", "Harbour 06-17", "sight", GENOA), stop("19:00", "Dinner 06-17", "meal", GENOA)] },
    { date: "2030-06-18", city: "Genoa", title: "", estimatedCost: 0, items: [stop("09:30", "Aquarium 06-18", "sight", GENOA), stop("12:30", "Lunch 06-18", "meal", GENOA)] },
  ];
}
