// The checked planner's deterministic parts (server/ai/checked): its output contract, the trip's frame, research
// lines dated outside a stay, where the stops are, and the checks of a plan. No model, no network: a made-up trip
// (tests/fixtures) with a fake routing service and a fake geocoder.
import { describe, expect, it } from "vitest";
import type { Day, Itinerary } from "../shared/types";
import { annotateResearch, buildFrames, datesIn, legHours, localCurrency, routeFrames, travelLoad } from "../server/ai/checked/frames";
import { daysSchema, itemSchema, OUTLINE_SCHEMA, dropNulls } from "../server/ai/checked/schema";
import { type CheckContext, dropSameDayRepeats, dropStandIns, filterEvents, foldTransfers, needMinutes, quickFixHours, quickFixMeals, score, shiftTimes, tidyDays, unverifiedTimes, validatePlan } from "../server/ai/checked/validate";
import { resolveDays, sameName, spotKey } from "../server/ai/checked/resolve";
import { evaluatePlan } from "../server/ai/checked/evaluate";
import { batchFrames, coerceDay, dedupeOutline, finishDay, travelNeeds, wakeStay } from "../server/ai/checked/planner";
import { namedMeal, mealSpot, placeOf, isRide, isDriveTransfer } from "../server/ai/checked/text";
import { usesChecked } from "../server/routes/itinerary";
import { planGaps } from "../web/src/itinerary/gaps";
import { ANNECY, CHAMONIX, GENOA, LYON, TURIN, fakeGeo, fakeRoute, fixturePlaces, fixtureTrip, fullDay, goodPlan, locate, stop } from "./fixtures/checked-trip";
import { minutes } from "../server/ai/checked/text";

/** The checks' context for some days: the frame, where the fixture put each stop, and the routed hops between them. */
async function context(days: Day[] = [], more: Partial<CheckContext> = {}): Promise<CheckContext> {
  const trip = fixtureTrip();
  const frames = buildFrames(trip, fixturePlaces);
  await routeFrames(frames, trip, fakeRoute);
  const located = locate(days);
  return { frames, stays: trip.stays, mustSee: trip.mustSee, skip: trip.skip, saved: fixturePlaces, pace: "balanced", dailyBudget: 200, known: "", getAround: "car", located, hops: await travelNeeds(days, located, fakeRoute, {}, (date) => wakeStay(frames, trip.stays, date)), ...more };
}
const resolveInput = (frames: CheckContext["frames"]) => ({ frames, stays: fixtureTrip().stays, saved: fixturePlaces, nearby: fixtureTrip().nearby!, countries: "fr,it", geo: fakeGeo });

const codes = (issues: { code: string; severity: string }[], sev?: string) => issues.filter((x) => !sev || x.severity === sev).map((x) => x.code);

describe("the output contract", () => {
  it("is strict everywhere: every key required, no extra keys, unknowns as null", () => {
    const walk = (s: any, path: string): string[] => {
      if (!s || typeof s !== "object") return [];
      const bad: string[] = [];
      if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) {
        if (s.additionalProperties !== false) bad.push(`${path}: additionalProperties`);
        if (JSON.stringify([...(s.required || [])].sort()) !== JSON.stringify(Object.keys(s.properties || {}).sort())) bad.push(`${path}: required`);
      }
      for (const [k, v] of Object.entries(s.properties || {})) bad.push(...walk(v, `${path}.${k}`));
      if (s.items) bad.push(...walk(s.items, `${path}[]`));
      // Constraints some providers reject; code checks them instead.
      for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern"]) if (k in s) bad.push(`${path}: ${k}`);
      return bad;
    };
    expect([...walk(daysSchema({ splits: true, named: false }), "days"), ...walk(OUTLINE_SCHEMA, "outline")]).toEqual([]);
    const plain = itemSchema({ splits: false, named: true }).required;
    expect(plain).toEqual(expect.arrayContaining(["time", "durationMinutes", "place", "kind", "cost", "transport"]));
    // Nothing the model would have to invent: no coordinates, no addresses, no websites; the group only when it can split.
    expect(plain).not.toEqual(expect.arrayContaining(["lat"]));
    expect(plain.some((k) => ["lng", "where", "website", "who", "group"].includes(k))).toBe(false);
    expect(itemSchema({ splits: true, named: true }).required).toContain("who");
    expect(itemSchema({ splits: true, named: false }).required).toEqual(expect.arrayContaining(["group", "people"]));
  });
  it("turns a strict answer into the app's stop: nulls gone (unknown), odd kinds to other, the model's coordinates dropped", () => {
    const d = coerceDay({ date: "2030-06-10", city: "Lyon", title: "x", notes: null, items: [
      { time: "09:00", durationMinutes: 60, place: "Museum", kind: "museum", description: "", transport: "Walk", cost: null, lat: 45.1, lng: 4.8, where: "Somewhere 9", booking: null, who: null },
      { place: "" }, null,
    ] })!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ kind: "other", place: "Museum" });
    expect("cost" in d.items[0] || "lat" in d.items[0] || "where" in d.items[0] || "booking" in d.items[0]).toBe(false);
    expect(coerceDay({ date: "June 10", items: [] })).toBeNull();
    expect(dropNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] });
  });
});

describe("what a stop's text says", () => {
  it("knows a meal's named place, a meal's rough spot and an activity's place", () => {
    expect(namedMeal("Dinner: Konoba Riva")).toBe("Konoba Riva");
    expect(namedMeal("Lunch at Gasthof Adler")).toBe("Gasthof Adler");
    expect(namedMeal("Lunch near the castle")).toBe("");
    expect(namedMeal("Dinner")).toBe("");
    expect(mealSpot("Lunch near the Great Market Hall")).toBe("Great Market Hall");
    expect(mealSpot("Dinner in Pest")).toBe("Pest");
    expect(placeOf("Walk along the Danube & Chain Bridge")).toBe("Danube & Chain Bridge");
    expect(placeOf("Relaxation at Hvar Beach")).toBe("Hvar Beach");
    expect(placeOf("Trogir Old Town")).toBe("Trogir Old Town");
  });
  it("reads a meal with an adjective in front, or written as a kind of restaurant", async () => {
    const { isMealStop, GENERIC_MEAL } = await import("../server/ai/checked/text");
    expect(namedMeal("Vegetarian Dinner in Old Town")).toBe("");
    expect(mealSpot("Vegetarian Dinner in Old Town")).toBe("Old Town");
    expect(namedMeal("Vegetarian Dinner at Hotel Adria")).toBe("Hotel Adria");
    expect(namedMeal("Vegetarian-friendly restaurant in Old Town")).toBe("");
    expect(mealSpot("Vegetarian-friendly restaurant in Old Town")).toBe("Old Town");
    expect(isMealStop({ kind: "sight", place: "Café in Old Town" })).toBe(true);
    expect(GENERIC_MEAL.test("Café Central")).toBe(false);
    expect(namedMeal("Lamm Café")).toBe("Lamm Café");
    expect(namedMeal("Hotel Breakfast")).toBe("");
    const { isHotelStop } = await import("../server/ai/checked/text");
    expect(isHotelStop({ place: "Zagreb Hotel" })).toBe(true);
    expect(isHotelStop({ place: "Split Hotel (Bag Drop)" })).toBe(true);
    expect(isHotelStop({ place: "Hotel Westin" })).toBe(true);
    expect(isHotelStop({ place: "Grand Hotel Spa Visit" })).toBe(false);
  });
  it("matches names on real words, not on 'lake' or 'bridge'", async () => {
    const { names } = await import("../server/ai/checked/text");
    expect(names("Chamonix old town and church", "Chamonix, France")).toBe(true);
    expect(names("Lake Balaton, Hungary", "Lake Bled, Slovenia")).toBe(false);
    expect(names("Lunch near Lake Bled", "Lake Bled, Slovenia")).toBe(true);
    expect(names("Chain Bridge", "Pelješac Bridge, Croatia")).toBe(false);
    expect(names("Old Town Square", "Old Town Square")).toBe(true);
  });
  it("tells rides from drives written as transfers", () => {
    expect(isRide({ kind: "transfer", place: "Split → Hvar (ferry)" })).toBe(true);
    expect(isRide({ kind: "transfer", place: "Ferry Crossing: Split to Hvar", transport: "Ferry" })).toBe(true);
    expect(isDriveTransfer({ kind: "transfer", place: "Hotel → Schönbrunn Palace (Car)" })).toBe(true);
    expect(isDriveTransfer({ kind: "transfer", place: "Walk to Hohensalzburg Fortress", transport: "Walk, 15 min" })).toBe(true);
    expect(isDriveTransfer({ kind: "sight", place: "Hvar Fort" })).toBe(false);
  });
});

describe("the checked prompts", () => {
  it("choose places as the travelers like, and carry what their wishes said", async () => {
    const { outlinePrompt, batchPrompt, placeRules } = await import("../server/ai/checked/prompts");
    const trip = fixtureTrip();
    expect(placeRules(trip)).toMatch(/two or three a day, with one lesser-known place a day/);
    expect(placeRules({ ...trip, placeMix: "popular" })).toMatch(/The lists are for restaurants and for checking names and hours/);
    expect(placeRules({ ...trip, prefs: { diet: ["vegetarian"], allergies: ["nuts"], avoid: [], wants: [{ kind: "lighthouse", what: "a lighthouse" }], placeMix: "hidden" } })).toMatch(/One famous sight a day at most[\s\S]*vegetarian diet[\s\S]*Allergies: nuts[\s\S]*asked to see: a lighthouse/);
    const frames = buildFrames(trip, fixturePlaces);
    const wished = [{ name: "Phare du Lac", kind: "lighthouse", extras: [], lat: 45.9, lng: 6.1, for: "a lighthouse", hours: "Sa-Su 10:00-17:00" }];
    const o = outlinePrompt({ trip, frames, candidates: [{ city: "Annecy, France", saved: [], sights: [], wished }], unplaced: [] });
    expect(o).toContain("### Annecy: what they asked to see, found nearby (OpenStreetMap)\n- a lighthouse: Phare du Lac (lighthouse; hours Sa-Su 10:00-17:00)");
    expect(o).toMatch(/## Choosing places/);
    const b = batchPrompt({ trip, frames: frames.slice(0, 1), outline: "", plans: new Map(), saved: [], sights: [], food: [], wished, used: [], research: "" });
    expect(b).toContain("## What they asked to see, found near these days' towns (OpenStreetMap)\n- a lighthouse: Phare du Lac");
  });
});

describe("the same place twice in a day", () => {
  it("drops the second, with the ride to it and back, and cuts a stop given half a day", () => {
    const days = goodPlan();
    const ISOLA = { lat: 45.89, lng: 8.52 };
    days[5].items.push(stop("16:00", "Museum 2030-06-15", "sight", TURIN)); // the museum again
    days[6].items.splice(1, 0, stop("09:00", "Turin → Isola Bella (ferry)", "transfer", ISOLA), stop("10:00", "Isola Bella", "sight", ISOLA), stop("12:00", "Isola Bella → Turin (ferry)", "transfer", TURIN));
    days[6].items.push(stop("15:00", "Turin → Isola Bella (ferry)", "transfer", ISOLA), stop("16:00", "Isola Bella", "sight", ISOLA), stop("18:00", "Isola Bella → Turin (ferry)", "transfer", TURIN));
    days[0].items[1].durationMinutes = 420; // seven hours in a museum
    const notes = dropSameDayRepeats(days);
    expect(days[5].items.filter((x) => /^Museum/.test(x.place))).toHaveLength(1);
    expect(days[6].items.filter((x) => /Isola Bella/.test(x.place)).map((x) => x.time)).toEqual(["09:00", "10:00", "12:00"]);
    expect(days[0].items[1].durationMinutes).toBe(180);
    expect(notes).toHaveLength(3);
    // A generic meal with an adjective in front isn't a sight the duplicate finder sees twice.
    const veg = goodPlan();
    veg[0].items.push(stop("19:30", "Vegetarian Dinner in Lyon", "meal", LYON));
    veg[1].items.push(stop("19:30", "Vegetarian Dinner in Lyon", "meal", LYON));
    expect(dropSameDayRepeats(veg)).toEqual([]);
  });
});

describe("meals named wrongly", () => {
  it("calls an evening 'lunch' dinner and turns a second visit to the same restaurant into a meal nearby", () => {
    const days = goodPlan();
    days[0].items[1].place = "Lunch near the castle"; days[0].items[1].time = "19:00";
    days[1].items.push(stop("13:00", "Gateway to India", "meal", LYON), stop("19:00", "Dinner at Gateway to India", "meal", LYON));
    days[2].items.push(stop("18:30", "Lunch near the lake", "meal", ANNECY)); // dinner at 19:00 follows
    days[3].items[1] = stop("10:15", "Lunch near Lake Annecy", "meal", ANNECY);
    const notes = quickFixMeals(days);
    expect(days[0].items[1].place).toBe("Dinner near the castle");
    expect(days[1].items.at(-1)).toMatchObject({ place: "Dinner near Gateway to India", kind: "meal" });
    expect(days[1].items.at(-2)!.place).toBe("Gateway to India");
    expect(days[2].items.some((x) => x.place === "Lunch near the lake")).toBe(false);
    expect(days[3].items[1].place).toBe("Coffee near Lake Annecy");
    expect(notes).toHaveLength(4);
    // A lunch at 13:00 and a dinner later stay as they are.
    const fine = goodPlan();
    expect(quickFixMeals(fine)).toEqual([]);
  });
});

describe("a ride to somewhere else", () => {
  it("makes the ride's destination the day's town, lands the ride where the day goes on, and reads 'Town: Place'", async () => {
    const { frames } = await context();
    const ISOLA = { lat: 45.89, lng: 8.52 };
    const day: Day = { date: "2030-06-16", city: "", title: "", estimatedCost: 0, items: [
      { time: "08:30", place: "Turin → Isola Bella (ferry)", kind: "transfer", description: "" },
      { time: "10:00", place: "Isola Bella Gardens", kind: "sight", description: "" },
      { time: "12:00", place: "Lunch near the gardens", kind: "meal", description: "" },
      { time: "16:00", place: "Isola Bella → Turin (ferry)", kind: "transfer", description: "" },
      { time: "19:00", place: "Turin: Museo Egizio", kind: "sight", description: "" },
    ] };
    const { located } = await resolveDays([day], resolveInput(frames));
    const spot = (i: number) => located.get(spotKey("2030-06-16", i));
    // The gardens were looked up around the island (the fake geocoder finds near where it's asked), not around Turin.
    expect(spot(1)!.lat).toBeCloseTo(ISOLA.lat + 0.004, 3);
    // The ferry out lands at the gardens, not in the island's middle; the ferry back at the stay.
    expect(spot(0)).toMatchObject({ lat: spot(1)!.lat, lng: spot(1)!.lng });
    expect(spot(3)).toMatchObject({ how: "stay", lat: TURIN.lat, lng: TURIN.lng });
    expect(spot(4)).toMatchObject({ how: "poi", name: "Museo Egizio" });
    // Back in Turin after the ferry, a meal that names no place is roughly in Turin, not on the island.
    day.items.push({ time: "20:00", place: "Dinner somewhere nice", kind: "meal", description: "" });
    const again = await resolveDays([day], resolveInput(frames));
    expect(again.located.get(spotKey("2030-06-16", 5))).toMatchObject({ how: "near", name: "Turin" });
  });
  it("looks a name that carries a town up in that town only, and wants real words to match", async () => {
    const { frames } = await context();
    const day: Day = { date: "2030-06-14", city: "", title: "", estimatedCost: 0, items: [
      { time: "16:00", place: "Hotel check-in Turin", kind: "other", description: "" },
      { time: "18:00", place: "Annecy Old Town", kind: "sight", description: "" }, // Annecy's, however late in the day
    ] };
    const { located } = await resolveDays([day], resolveInput(frames));
    expect(located.get(spotKey("2030-06-14", 1))!.lat).toBeCloseTo(ANNECY.lat + 0.004, 3);
    expect(sameName("Sea Organ", { name: "Californian sea lion", label: "Californian sea lion, Ljubljana" }, new Set(["ljubljana"]))).toBe(false);
    expect(sameName("Sea Organ", { name: "Sea organ", label: "", names: ["Morske orgulje"] })).toBe(true);
    expect(sameName("Stari Grad Plain", { name: "Stari Grad", label: "" })).toBe(true);
    expect(sameName("Marin Držić Square", { name: "Ulica Marina Držića", label: "Ulica Marina Držića, Split" }, new Set(["split"]))).toBe(true);
    expect(sameName("Marin Držić Square", { name: "Hvar", label: "Hvar, Croatia" }, new Set(["split"]))).toBe(false);
    // Split's cathedral, found right in Split, isn't "Hvar Cathedral" even though it's in town.
    const duje = { name: "Katedrala Svetog Duje", label: "Cathedral of Saint Domnius, Split, Croatia" };
    expect(sameName("Hvar Cathedral", duje, new Set(["split", "hvar", "island"]), true, new Set(["split"]))).toBe(false);
    expect(sameName("Split Cathedral", duje, new Set(["split", "hvar", "island"]), true, new Set(["split"]))).toBe(true);
    expect(sameName("Hvar Cathedral", { name: "Katedrala sv. Stjepana", label: "", names: ["Hvar Cathedral"] }, new Set(["split"]))).toBe(true);
  });
  it("doesn't take a place a short walk can't reach, nor a far-off town as a shuttle's destination", async () => {
    const { frames } = await context();
    const day: Day = { date: "2030-06-15", city: "", title: "", estimatedCost: 0, items: [
      { time: "09:00", place: "Museo Egizio", kind: "sight", description: "" },
      // The fake geocoder finds "Elsewhere…" under another name near the town: with a 5-minute walk from the museum
      // it's accepted only when near; "Faraway Chapel" is found 0.6° (60+ km) off by the fixture's "far" rule.
      { time: "11:00", place: "Far Chapel", kind: "sight", description: "", transport: "Walk, 5 min" },
      { time: "12:00", place: "Shuttle bus to Faraway", kind: "transfer", description: "" },
    ] };
    const { located } = await resolveDays([day], { ...resolveInput(frames), geo: async (q, cc, near, kind) => (/^far chapel/i.test(q) && near ? { lat: near[0] + 0.3, lng: near[1], name: "Far Chapel", label: "Far Chapel, Somewhere", country: "", cc: "it", kind: "attraction" } : fakeGeo(q, cc, near, kind)) });
    expect(located.get(spotKey("2030-06-15", 1))).toBeUndefined(); // 33 km isn't a 5-minute walk
    day.items[1].transport = "Taxi, 10 min";
    expect((await resolveDays([day], { ...resolveInput(frames), geo: async (q, cc, near, kind) => (/^far chapel/i.test(q) && near ? { lat: near[0] + 0.3, lng: near[1], name: "Far Chapel", label: "Far Chapel, Somewhere", country: "", cc: "it", kind: "attraction" } : fakeGeo(q, cc, near, kind)) })).located.get(spotKey("2030-06-15", 1))).toBeUndefined(); // nor a 10-minute taxi
    // A restaurant isn't the village of the same name.
    const eat: Day = { date: "2030-06-15", city: "", title: "", estimatedCost: 0, items: [
      { time: "13:00", place: "Konoba Rukavac", kind: "meal", description: "" },
      { time: "15:00", place: "Rukavac Beach", kind: "sight", description: "" },
    ] };
    const r3 = await resolveDays([eat], { ...resolveInput(frames), geo: async (q, cc, near, kind) => { const h = await fakeGeo(q, cc, near, kind); return h && /rukavac/i.test(q) ? { ...h, name: "Rukavac", kind: "village" } : h; } });
    expect(r3.located.get(spotKey("2030-06-15", 0))).toBeUndefined();
    expect(r3.located.get(spotKey("2030-06-15", 1))).toBeDefined(); // a beach near the village is fine
    // Once the day has arrived in Annecy, a café a short walk away can't be back in Lyon.
    const moved: Day = { date: "2030-06-12", city: "", title: "", estimatedCost: 0, items: [
      { time: "14:00", place: "Hotel check-in", kind: "other", description: "" },
      { time: "15:00", place: "Café Kaveza", kind: "meal", description: "", transport: "Walk, 5 min" },
    ] };
    const r4 = await resolveDays([moved], { ...resolveInput(frames), geo: async (q, cc, near, kind) => (/kaveza/i.test(q) ? (/lyon/i.test(q) ? { lat: LYON.lat, lng: LYON.lng, name: "Café Kaveza", label: "Café Kaveza, Lyon", country: "", cc: "fr", kind: "cafe" } : null) : fakeGeo(q, cc, near, kind)) });
    expect(r4.located.get(spotKey("2030-06-12", 1))).toBeUndefined();
    // A place from Turin's list doesn't serve a five-minute walk in Chamonix.
    const listed: Day = { date: "2030-06-14", city: "", title: "", estimatedCost: 0, items: [
      { time: "11:00", place: "Chamonix", kind: "sight", description: "", fromList: true },
      { time: "12:00", place: "Trattoria Valenza", kind: "meal", description: "", transport: "Walk, 5 min" },
    ] };
    const r5 = await resolveDays([listed], resolveInput(frames));
    expect(r5.located.get(spotKey("2030-06-14", 1))?.how).not.toBe("poi");
    // After a ferry found only as the island it goes to, the walk from "there" rules nothing out.
    const island: Day = { date: "2030-06-16", city: "", title: "", estimatedCost: 0, items: [
      { time: "08:30", place: "Turin → Isola Bella (ferry)", kind: "transfer", description: "" },
      { time: "10:00", place: "Far Chapel", kind: "sight", description: "", transport: "Walk, 5 min" },
    ] };
    const r2 = await resolveDays([island], { ...resolveInput(frames), geo: async (q, cc, near, kind) => (/^far chapel/i.test(q) && near ? { lat: near[0] + 0.3, lng: near[1], name: "Far Chapel", label: "Far Chapel, Somewhere", country: "", cc: "it", kind: "attraction" } : fakeGeo(q, cc, near, kind)) });
    expect(r2.located.get(spotKey("2030-06-16", 1))).toBeDefined();
    expect(located.get(spotKey("2030-06-15", 2))).toBeUndefined(); // a town 380 km away is not a shuttle's destination
  });
});

describe("meals and travel order", () => {
  it("wants lunch and dinner on a full day, and the arrival town's stops after the departure's on a travel day", async () => {
    const days = goodPlan();
    days[0].items = days[0].items.filter((x) => !/^Bistro/.test(x.place)); // no dinner on the 10th
    days[1].items = days[1].items.filter((x) => !/^Trattoria/.test(x.place)); // no lunch on the 11th
    days[2].items.unshift(stop("08:00", "Lake walk early", "sight", ANNECY)); // Annecy before leaving Lyon
    const found = validatePlan(days, await context(days));
    expect(found.filter((x) => x.code === "meal-missing").map((x) => `${x.date} ${x.message.replace(/ on this day.*/, "")}`)).toEqual(["2030-06-10 No dinner", "2030-06-11 No lunch"]);
    expect(found.find((x) => x.code === "order" && x.date === "2030-06-12")?.message).toMatch(/"Lake walk early" is in Annecy, where the day ends, but comes before "Hotel check-out" in Lyon/);
    expect(validatePlan(goodPlan(), await context(goodPlan())).filter((x) => x.code === "meal-missing" || x.code === "order")).toEqual([]);
  });
});

describe("a day trip made twice, seen on the map", () => {
  it("flags the second full day of a stay that goes out to the same place", async () => {
    const days = goodPlan();
    const ISLAND = { lat: TURIN.lat + 0.3, lng: TURIN.lng }; // some 33 km out
    days[5].items.splice(1, 0, stop("10:00", "Island Town", "sight", ISLAND), stop("12:00", "Island Fort", "sight", { lat: ISLAND.lat + 0.02, lng: ISLAND.lng }));
    days[6].items.splice(1, 0, stop("10:00", "Island Beach", "sight", { lat: ISLAND.lat + 0.05, lng: ISLAND.lng }));
    const found = validatePlan(days, await context(days)).filter((x) => x.code === "repeat-day-trip");
    expect(found.map((x) => [x.date, x.item])).toEqual([["2030-06-16", 1]]);
    expect(found[0].message).toMatch(/"Island Beach" is where 2030-06-15 already went/);
    // The same restaurant on two days, in two towns: not twice.
    const konoba = goodPlan();
    konoba[1].items.push(stop("19:30", "Konoba Plitvica", "meal", LYON));
    konoba[5].items.push(stop("19:30", "Dinner: Konoba Plitvica", "meal", TURIN));
    expect(validatePlan(konoba, await context(konoba)).filter((x) => x.code === "duplicate-restaurant").map((x) => [x.date, x.message.slice(0, 51)])).toEqual([["2030-06-15", '"Dinner: Konoba Plitvica" is already the restaurant']]);
    // A café the model calls a sight on one day and an activity on another is still the same café twice.
    const cafe = goodPlan();
    cafe[0].items.push(stop("15:00", "Café Kavana", "meal", LYON));
    cafe[5].items.push(stop("15:00", "Café Kavana", "sight", TURIN));
    cafe[8].items.push(stop("15:00", "Café Kavana", "activity", GENOA));
    expect(validatePlan(cafe, await context(cafe)).filter((x) => x.code === "duplicate-restaurant").map((x) => x.date)).toEqual(["2030-06-15", "2030-06-18"]);
    // Two different places out of town, far apart, are two day trips.
    const two = goodPlan();
    two[5].items.splice(1, 0, stop("10:00", "North Lake", "sight", { lat: TURIN.lat + 0.3, lng: TURIN.lng }));
    two[6].items.splice(1, 0, stop("10:00", "South Abbey", "sight", { lat: TURIN.lat - 0.3, lng: TURIN.lng }));
    expect(validatePlan(two, await context(two)).filter((x) => x.code === "repeat-day-trip")).toEqual([]);
  });
});

describe("what they asked to see", () => {
  it("asks the emptiest full day of the right stay for a wish nothing meets, and is content once a stop does", async () => {
    const days = goodPlan();
    const wants = [{ kind: "lighthouse" as const, what: "a lighthouse", where: "Turin" }, { kind: "castle" as const, what: "a castle" }, { kind: "thermal_bath" as const, what: "thermal baths", where: "Reykjavik" }];
    const faro = { name: "Faro della Vittoria", kind: "lighthouse", extras: [], lat: TURIN.lat + 0.02, lng: TURIN.lng, for: "a lighthouse", hours: "Sa-Su 10:00-17:00" };
    const wished = [{ city: "Turin, Italy", sights: [], food: [], wished: [faro] }];
    const ctx = await context(days, { wants, wished });
    const unmet = validatePlan(days, ctx).filter((x) => x.code === "wish-unmet");
    const turinFull = ctx.frames.filter((f) => f.kind === "full" && f.sleep && /^Turin/.test(ctx.stays[f.sleep.idx].city)).map((f) => f.date);
    expect(unmet).toHaveLength(3);
    expect(unmet[0]).toMatchObject({ severity: "repair" });
    expect(turinFull).toContain(unmet[0].date);
    expect(unmet[0].message).toMatch(/a lighthouse \(Turin\).*Faro della Vittoria \(hours Sa-Su 10:00-17:00\)/);
    expect(unmet[1]).toMatchObject({ severity: "repair" }); // anywhere: some full day, a real place the model knows
    expect(unmet[1].message).toMatch(/a castle, and no stop.*a real one you know of/);
    expect(unmet[2].severity).toBe("warn"); expect(unmet[2].date).toBeUndefined(); // no stay there
    // A repair round for other days doesn't carry it.
    expect(validatePlan(days, ctx, new Set(["2030-06-11"])).filter((x) => x.code === "wish-unmet")).toEqual([]);
    // Met by naming the place found, by its kind (as located), and by the wish's own word in a name.
    const met = goodPlan();
    met[6].items.push(stop("16:30", "Faro della Vittoria", "sight", { lat: TURIN.lat + 0.02, lng: TURIN.lng }));
    met[7].items.push(stop("16:30", "Valentino Castle", "sight", TURIN));
    expect(validatePlan(met, await context(met, { wants, wished })).filter((x) => x.code === "wish-unmet").map((x) => x.message.slice(0, 32))).toEqual(["They asked to see thermal baths "]);
    // ...and by what the stop's text says it is.
    const said = goodPlan();
    said[6].items.push({ ...stop("10:00", "Plitvice Lakes National Park", "sight", TURIN), description: "Boardwalks past the park's cascading waterfalls." });
    expect(validatePlan(said, await context(said, { wants: [{ kind: "waterfall", what: "cascading waterfalls" }] })).filter((x) => x.code === "wish-unmet")).toEqual([]);
    const byKind = goodPlan();
    byKind[6].items.push(stop("16:30", "Castello del Valentino", "sight", TURIN));
    const kctx = await context(byKind, { wants: [wants[1]], wished });
    kctx.located!.set(spotKey("2030-06-16", byKind[6].items.length - 1), { lat: TURIN.lat, lng: TURIN.lng, how: "poi", name: "Castello del Valentino", kind: "castle" });
    expect(validatePlan(byKind, kctx).filter((x) => x.code === "wish-unmet")).toEqual([]);
  });
});

describe("the trip's frame", () => {
  it("leaves a saved place that is a stay out of the stops, and a town-named last stop with nothing after it", async () => {
    const { withoutStays } = await import("../server/ai/checked/planner");
    const trip = fixtureTrip();
    const home = { title: "Rue de la Gare 3", lat: trip.stays[0].lat, lng: trip.stays[0].lng };
    const hotel = { title: trip.stays[1].city, lat: 0, lng: 0 };
    expect(withoutStays({ stays: [{ ...trip.stays[0], nights: 0 }, trip.stays[1]] }, [home, hotel, ...fixturePlaces]).map((p) => p.title)).toEqual(fixturePlaces.map((p) => p.title));
    // The same home with a night in it is a place one can stay at, so it stays a place.
    expect(withoutStays({ stays: [{ ...trip.stays[0], nights: 2 }] }, [home])).toHaveLength(1);
    const days = goodPlan();
    const last = days[days.length - 1];
    last.items.push(stop("16:00", "Arrival at Lyon", "other", LYON));
    // "Walk to the fort" is the way to the next stop, not a stop.
    const walkDay = goodPlan()[0];
    walkDay.items.splice(1, 0, stop("10:30", "Walk to the Museum", "activity", LYON, { durationMinutes: 15 }));
    const walkNotes = dropStandIns([walkDay], { frames: buildFrames(trip, fixturePlaces), stays: trip.stays, saved: fixturePlaces });
    expect(walkDay.items[1].kind).toBe("transfer");
    const driveEnd = goodPlan()[2];
    driveEnd.items.push(stop("20:00", "Lyon → Annecy (car)", "transfer", ANNECY));
    const driveNotes = dropStandIns([driveEnd], { frames: buildFrames(trip, fixturePlaces), stays: trip.stays, saved: fixturePlaces });
    expect(driveEnd.items.some((x) => /→ Annecy \(car\)/.test(x.place))).toBe(false);
    expect(driveNotes.join(" ")).toMatch(/left out "Lyon → Annecy \(car\)" at the end/);
    const homeDay = goodPlan()[2];
    homeDay.items.push(stop("18:00", "Arrival Home", "other", ANNECY));
    dropStandIns([homeDay], { frames: buildFrames(trip, fixturePlaces), stays: trip.stays, saved: fixturePlaces });
    expect(homeDay.items.some((x) => x.place === "Arrival Home")).toBe(false);
    expect(walkNotes.join(" ")).toMatch(/"Walk to the Museum" is the way to the next stop/);
    const frames = buildFrames(trip, fixturePlaces);
    const before = last.items.length;
    const notes = dropStandIns([last], { frames: frames.filter((f) => f.date === last.date && f.legs.length).length ? frames : [{ ...frames.find((f) => f.date === last.date)!, legs: [{ from: "Genoa", to: "Lyon", fromIdx: 3, toIdx: 0, stops: [], segments: [] } as any] }], stays: trip.stays, saved: fixturePlaces });
    expect(last.items).toHaveLength(before - 1);
    expect(notes.join(" ")).toMatch(/left out "Arrival at Lyon" \(the drive there is drawn by the map\)/);
  });
  it("has every date, travel days, where they sleep, and the stop on the way on its leg", async () => {
    const { frames } = await context();
    expect(frames.map((f) => f.date)).toEqual(["2030-06-10", "2030-06-11", "2030-06-12", "2030-06-13", "2030-06-14", "2030-06-15", "2030-06-16", "2030-06-17", "2030-06-18"]);
    expect(frames.map((f) => f.kind[0]).join("")).toBe("fftftfftt");
    expect(frames[4].sleep?.city).toBe("Turin, Italy");
    expect(frames.at(-1)!.sleep).toBeNull();
    const leg = frames[4].legs[0];
    expect(leg.stops.map((s) => s.name)).toEqual(["Chamonix, France"]);
    expect(leg.segments.map((s) => s.to)).toEqual(["Chamonix, France", "Turin, Italy"]);
    expect(legHours(leg)).toBeGreaterThan(2.5); // through Chamonix, not the direct 2.6 h
    expect(leg.stops[0].alternative?.city).toBe("Annecy, France"); // a day trip from Annecy instead
    expect(travelLoad(frames[4])!.total).toBeGreaterThan(legHours(leg)!);
  });
  it("keeps only the holidays of the country they're in that day", async () => {
    const { frames } = await context();
    expect(frames[3].holidays).toEqual([]); // the Italian day falls while they're still in France
    expect(frames[5].holidays[0]).toMatch(/Invented Regional Day.*regional only: IT-21/);
  });
  it("knows the local currency, by nights", () => {
    expect(localCurrency(fixtureTrip())).toBe("EUR");
    const t = fixtureTrip(); t.stays[0].cc = "CH"; t.stays[0].nights = 9;
    expect(localCurrency(t)).toBe("CHF");
  });
  it("writes the days of one stay together, a few at a time", async () => {
    const { frames } = await context();
    expect(batchFrames(frames, 2).map((b) => b.map((f) => f.date.slice(8)).join(","))).toEqual(["10,11", "12,13", "14,15", "16", "17,18"]);
  });
});

describe("research findings", () => {
  it("reads the dates a line names", () => {
    expect(datesIn("Concert on September 16, 2030 and 3 Oct; also 2030-06-12", 2030).sort()).toEqual(["2030-06-12", "2030-09-16", "2030-10-03"]);
  });
  it("marks events dated outside the stay of the town they're about, and leaves the rest", () => {
    const notes = annotateResearch("- Lyon: a big concert on June 20, 2030 [https://example.org]\n- Turin: food market on 15 June\n- Genoa: open daily", fixtureTrip());
    expect(notes).toMatch(/June 20, 2030.*\n.*2030-06-20 is outside the Lyon stay \(2030-06-10 to 2030-06-12\); don't plan with it/);
    expect(notes).not.toMatch(/Turin: food market on 15 June\n.*don't plan/);
  });
  it("drops events outside the trip or outside the stay in their town", async () => {
    const ctx = await context();
    const { kept, dropped } = filterEvents([
      { date: "2030-06-15", name: "Market", where: "Turin" }, { date: "2030-06-16", name: "Concert", where: "Lyon" },
      { date: "2030-07-01", name: "Late fair", where: "" }, { date: "summer", name: "Undated", where: "" },
    ], ctx);
    expect(kept.map((e) => e.name)).toEqual(["Market", "Undated"]);
    expect(dropped.join(" ")).toMatch(/Concert.*only 2030-06-10 to 2030-06-12.*Late fair.*outside the trip/);
  });
});

describe("where the stops are (worked out in code)", () => {
  it("uses saved places, OpenStreetMap places, the stay for hotel stops, and lookups by name; drops the model's coordinates", async () => {
    const { frames } = await context();
    const day: Day = { date: "2030-06-14", city: "", title: "", estimatedCost: 0, items: [
      { time: "08:30", place: "Hotel check-out", kind: "other", description: "", lat: 1, lng: 1 },
      { time: "09:45", place: "Chamonix", kind: "sight", description: "", fromList: true, lat: 40, lng: 2 },
      { time: "12:00", place: "Lunch near Chamonix", kind: "meal", description: "" },
      { time: "16:00", place: "Check-in at the hotel", kind: "other", description: "" },
      { time: "17:00", place: "Dinner: Trattoria Valenza", kind: "meal", description: "" },
      { time: "19:00", place: "Museo Egizio", kind: "sight", description: "" },
      { time: "20:30", place: "Evening stroll Piazza Castello", kind: "activity", description: "" },
      { time: "21:30", place: "Elsewhere Bar", kind: "meal", description: "" },
      { time: "22:00", place: "Dinner in Turin", kind: "meal", description: "" },
    ] };
    const { located, notes } = await resolveDays([day], resolveInput(frames));
    const spot = (i: number) => located.get(spotKey("2030-06-14", i));
    expect(spot(0)).toMatchObject({ how: "stay", lat: ANNECY.lat, lng: ANNECY.lng }); // checking out: where they woke up
    expect(spot(1)).toMatchObject({ how: "saved", lat: CHAMONIX.lat, lng: CHAMONIX.lng });
    // "Chain Bridge" isn't the saved "Pelješac Bridge" (only "bridge" in common): looked up by name instead.
    const other: Day = { date: "2030-06-14", city: "", title: "", estimatedCost: 0, items: [{ time: "10:00", place: "Chain Bridge", kind: "sight", description: "" }] };
    const r2 = await resolveDays([other], { ...resolveInput(frames), saved: [...fixturePlaces, { title: "Pelješac Bridge, Croatia", lat: 42.93, lng: 17.54 }] });
    expect(r2.located.get(spotKey("2030-06-14", 0))?.how).toBe("geocoded");
    expect(day.items[1]).toMatchObject({ lat: CHAMONIX.lat, lng: CHAMONIX.lng, fixed: true, fromList: true });
    expect(notes.join(" ")).toMatch(/"Chamonix" is your saved "Chamonix, France"/);
    expect(spot(2)).toMatchObject({ how: "near", name: "Chamonix" }); // lunch somewhere in a town: roughly there (for the timeline), not pinned
    expect(day.items[2].fixed).toBeUndefined();
    expect(spot(3)).toMatchObject({ how: "stay", lat: TURIN.lat, lng: TURIN.lng }); // checking in: where they arrive
    expect(spot(4)).toMatchObject({ how: "poi", name: "Trattoria Valenza" });
    expect(spot(5)).toMatchObject({ how: "poi", hours: "Tu-Su 09:00-18:30" });
    expect(spot(6)?.how).toBe("geocoded"); // "Piazza Castello, Turin" found near Turin
    expect(spot(7)).toBeUndefined(); // found under a name that shares no word: not trusted
    expect(spot(8)).toMatchObject({ how: "near", name: "Turin" }); // dinner somewhere in Turin: roughly there, not pinned
    expect(day.items[8].fixed).toBeUndefined();
    expect(day.items[6].fixed).toBe(true);
    expect("where" in day.items[0] || day.items[0].lat !== ANNECY.lat).toBe(false);
  });
  it("puts a meal near a named spot roughly there, and a ride where it arrives", async () => {
    const { frames } = await context();
    const day: Day = { date: "2030-06-15", city: "", title: "", estimatedCost: 0, items: [
      { time: "12:00", place: "Lunch near Museo Egizio", kind: "meal", description: "" },
      { time: "14:00", place: "Turin → Genoa (train)", kind: "transfer", description: "" },
    ] };
    const { located } = await resolveDays([day], resolveInput(frames));
    expect(located.get(spotKey("2030-06-15", 0))).toMatchObject({ how: "near", lat: 45.0685 });
    expect(day.items[0].fixed).toBeUndefined();
    expect(located.get(spotKey("2030-06-15", 1))).toMatchObject({ how: "stay", lat: GENOA.lat });
    // A ride back "to the hotel" arrives at the stay, never at some town called Hotel.
    const back: Day = { date: "2030-06-15", city: "", title: "", estimatedCost: 0, items: [{ time: "12:45", place: "Fortress → Hotel (cable car)", kind: "transfer", description: "" }] };
    const r = await resolveDays([back], resolveInput(frames));
    expect(r.located.get(spotKey("2030-06-15", 0))).toMatchObject({ how: "stay", lat: TURIN.lat });
  });
  it("accepts a found place only when it really has the stop's name", () => {
    expect(sameName("City Walls", { name: "Gradske zidine", label: "Gradske zidine, Dubrovnik", names: ["City Walls"] })).toBe(true);
    expect(sameName("Split Port", { name: "Port of Omiš", label: "Port of Omiš" }, new Set(["split"]))).toBe(false);
    expect(sameName("Museo Egizio", { name: "Museo Egizio", label: "Museo Egizio, Torino" })).toBe(true);
    expect(sameName("Prešeren Square", { name: "Prešernov trg", label: "Prešernov trg, Ljubljana" })).toBe(true);
    expect(sameName("Hvar Cathedral", { name: "Katedrala Svetog Duje", label: "Katedrala Svetog Duje, Split" }, new Set(["hvar", "split"]))).toBe(false);
    expect(sameName("Hvar Cathedral", { name: "Cathedral of Saint Domnius", label: "Cathedral of Saint Domnius, Peristil 2, Grad, Split, Croatia" }, new Set(["split", "hvar", "island"]))).toBe(false);
    expect(sameName("Hvar Cathedral", { name: "Katedrala sv. Stjepana", label: "Katedrala sv. Stjepana, Hvar, Croatia", names: ["Hvar Cathedral"] }, new Set(["split", "hvar", "island"]))).toBe(true);
    expect(sameName("Chain Bridge", { name: "Széchenyi lánchíd", label: "Széchenyi lánchíd, Budapest", names: ["Széchenyi Chain Bridge"] }, new Set(["budapest"]))).toBe(true);
  });
});

describe("the time between stops", () => {
  it("is estimated from the distance and how they go, or taken from the routing service", () => {
    expect(needMinutes(0.8, "Walk, 10 min")).toBe(10);
    expect(needMinutes(3, "Walk")).toBe(36);
    expect(needMinutes(4, "Metro M2, 12 min")).toBe(26);
    expect(needMinutes(4, "10 min drive, park at the garage")).toBe(18);
    expect(needMinutes(40, "Ferry")).toBeNull();
    expect(needMinutes(120, "Drive", 95)).toBe(115);
  });
});

describe("checking a plan", () => {
  it("passes a feasible plan without repairs", async () => {
    const days = goodPlan();
    const ctx = await context(days);
    const found = validatePlan(days, ctx);
    expect(codes(found, "repair")).toEqual([]);
    expect(codes(found, "hard")).toEqual([]);
    expect(Object.keys(ctx.hops!).sort()).toEqual(["2030-06-12#1", "2030-06-14#0", "2030-06-14#2", "2030-06-17#0"]); // the drives into Annecy, to Chamonix and on to Turin, and to Genoa
  });
  it("finds missing, doubled and out-of-trip dates", async () => {
    const days = goodPlan().filter((d) => d.date !== "2030-06-13");
    days.push({ ...fullDay("2030-06-11", "Lyon", LYON) }, fullDay("2030-06-30", "Lyon", LYON));
    const ctx = await context(days);
    const found = validatePlan(days, ctx);
    expect(found.filter((x) => x.severity === "hard").map((x) => `${x.code} ${x.date}`).sort()).toEqual(["duplicate-date 2030-06-11", "missing-day 2030-06-13", "outside-trip 2030-06-30"]);
    const tidied = tidyDays(days, ctx);
    expect(tidied.days.map((d) => d.date)).not.toContain("2030-06-30");
    expect(tidied.notes.join(" ")).toMatch(/second copy of 2030-06-11.*|2030-06-30/);
  });
  it("flags repeated sights and restaurants (also under 'Dinner: …'), but not repeated logistics or generic meals", async () => {
    const days = goodPlan();
    days[1].items.push(stop("16:30", "Old Town walk 2030-06-10", "sight", LYON), stop("20:30", "Dinner: Trattoria 2030-06-10", "meal", LYON));
    days[3].items.unshift(stop("08:00", "Check out of the hotel", "other", ANNECY));
    days[2].items.unshift(stop("08:00", "Check out of the hotel", "other", LYON));
    days[3].items.push(stop("12:30", "Lunch", "meal", ANNECY)); days[4].items.push(stop("20:30", "Lunch", "meal", TURIN));
    const found = validatePlan(days, await context(days)).filter((x) => /duplicate/.test(x.code));
    expect(found.map((x) => `${x.code} ${x.date}`)).toEqual(["duplicate-place 2030-06-11", "duplicate-restaurant 2030-06-11"]);
  });
  it("flags a dinner in the afternoon", async () => {
    const days = goodPlan();
    days[5].items[4].time = "15:00"; days[5].items[4].place = "Dinner near the river";
    days[5].items.sort((a, b) => a.time.localeCompare(b.time));
    expect(validatePlan(days, await context(days)).filter((x) => x.code === "meal-time").map((x) => x.date)).toEqual(["2030-06-15"]);
  });
  it("flags overlaps, stops out of order and impossible costs", async () => {
    const days = goodPlan();
    days[0].items[0].durationMinutes = 180; // 09:00-12:00 runs into the 11:00 museum
    days[5].items.reverse();
    days[6].items[0].cost = -5;
    const found = validatePlan(days, await context(days));
    expect(found.filter((x) => x.date === "2030-06-10").map((x) => x.code)).toContain("overlap");
    expect(found.filter((x) => x.date === "2030-06-15").map((x) => x.code)).toContain("order");
    expect(found.filter((x) => x.date === "2030-06-16").map((x) => x.code)).toContain("cost-invalid");
  });
  it("wants the time to get from one stop to the next: a drive by the routing service, a walk by its length", async () => {
    const days = goodPlan();
    days[4].items[2].time = "13:15"; // check-in in Turin an hour after lunch in Chamonix (a 2.5 h drive)
    days[0].items[1] = stop("10:30", "Far museum 06-10", "sight", { lat: LYON.lat + 0.03, lng: LYON.lng }, { transport: "Walk, 5 min" }); // 3 km on foot, 10:30 after a 09:00-10:30 walk
    const found = validatePlan(days, await context(days)).filter((x) => x.code === "no-time-between");
    expect(found.map((x) => `${x.date}#${x.item}`)).toEqual(["2030-06-10#1", "2030-06-14#2"]);
    expect(found[1].message).toMatch(/getting there takes about 2 h.*routing service/);
    expect(found[0].message).toMatch(/about 40 min \(3 km\)/);
  });
  it("notices a day that starts away from where they woke up too early for the drive", async () => {
    const days = goodPlan();
    days[4].items[0].time = "07:30"; // Chamonix at 07:30: an hour's drive from Annecy means leaving at 06:15
    days[4].items[1].time = "09:30";
    const found = validatePlan(days, await context(days)).filter((x) => x.code === "leaves-too-early");
    expect(found).toMatchObject([{ date: "2030-06-14", item: 0 }]);
    expect(found[0].message).toMatch(/from Annecy, where they wake up \(routing service\): they'd have to leave at 0[56]:\d\d/);
  });
  it("wants a day trip once per stay, and never the same restaurant twice in a day", async () => {
    const days = goodPlan();
    const ISOLA = { lat: 45.89, lng: 8.52 };
    const hvar = (date: string) => [stop("08:30", "Turin → Isola Bella (ferry)", "transfer", ISOLA, { durationMinutes: 60 }), stop("10:00", `Isola Bella walk ${date}`, "sight", ISOLA), stop("16:00", "Isola Bella → Turin (ferry)", "transfer", TURIN, { durationMinutes: 60 }), stop("19:00", `Dinner ${date}`, "meal", TURIN)];
    days[5].items = hvar("06-15"); days[6].items = hvar("06-16");
    days[0].items.push(stop("20:30", "Dinner at Trattoria 2030-06-10", "meal", LYON));
    const found = validatePlan(days, await context(days));
    expect(found.filter((x) => x.code === "repeat-day-trip").map((x) => x.date)).toEqual(["2030-06-16"]);
    // The must-see on the way to Turin, seen again on another day: a repeat wherever it is.
    const twice = goodPlan();
    twice[7].items.push(stop("16:30", "Chamonix", "sight", CHAMONIX, { fromList: true }));
    expect(validatePlan(twice, await context(twice)).filter((x) => x.code === "duplicate-place").map((x) => `${x.date}#${x.item}`)).toEqual(["2030-06-17#3"]);
    expect(found.find((x) => x.code === "same-restaurant")).toMatchObject({ date: "2030-06-10", item: 5 });
  });
  it("takes the outline's repeated day trip off the later days of the stay", async () => {
    const { frames } = await context();
    const plans = new Map([["2030-06-15", { title: "Hvar", theme: "", places: ["Island Old Town", "Blue Cave"] }], ["2030-06-16", { title: "Hvar", theme: "", places: ["Island Old Town", "Blue Cave"] }]]);
    const notes = dedupeOutline(plans, frames, fixtureTrip());
    expect(plans.get("2030-06-15")!.places).toEqual(["Island Old Town", "Blue Cave"]);
    expect(plans.get("2030-06-16")).toMatchObject({ places: [], title: "Turin: another day" });
    expect(notes.join(" ")).toMatch(/2030-06-16: Island Old Town, Blue Cave were already on an earlier day/);
  });
  it("turns a town's name used as a stop into the drive there, and drops check-in/out on days without a hotel change", async () => {
    const ctx = await context();
    const days = goodPlan();
    days[2].items.splice(1, 0, stop("11:30", "Annecy, France", "sight", ANNECY, { durationMinutes: 120, transport: "Drive, 2 h" }));
    days[2].items.splice(0, 0, stop("09:00", "Lyon (Hotel)", "other", LYON, { durationMinutes: 15, transport: "Start of day" }));
    days[3].items.push(stop("21:00", "Hotel Check-in", "other", ANNECY), stop("09:00", "Check-out & leave bags", "other", ANNECY));
    days[7].items.unshift(stop("08:00", "Drive to Genoa", "other", TURIN, { durationMinutes: 150, transport: "Car" }));
    const notes = dropStandIns(days, ctx);
    expect(days[2].items.filter((x) => x.kind === "transfer").map((x) => x.place)).toEqual(["Lyon (Hotel)", "Annecy, France"]);
    expect(days[7].items[0].kind).toBe("transfer");
    expect(days[3].items.map((x) => x.place)).not.toContain("Hotel Check-in");
    expect(days[3].items.map((x) => x.place)).toContain("Check-out & leave bags");
    expect(notes.join(" ")).toMatch(/"Annecy, France" is the way to Annecy/);
    foldTransfers(days);
    expect(days[2].items.map((x) => x.place)).toEqual(["Hotel check-out", "Lunch 06-12", "Hotel check-in", "Lake walk 06-12", "Dinner 06-12"]);
    expect(days[2].items[1].transport).toBe("Drive, 2 h; Drive, 2 h 10 min");
  });
  it("moves a stop that starts before it can be reached, and what follows with it", async () => {
    const days = goodPlan();
    days[4].items[2].time = "13:15"; days[4].items[3].time = "14:00"; // check-in in Turin an hour after lunch in Chamonix
    days[6].items[1].time = "09:30"; // the museum while the 09:00 walk (90 min) is still on
    const ctx = await context(days);
    const notes = shiftTimes(days, ctx);
    expect(days[4].items.slice(0, 2).map((x) => x.time)).toEqual(["09:45", "12:00"]);
    expect(minutes(days[4].items[2].time)).toBeGreaterThanOrEqual(13 * 60 + 2 * 60);
    expect(minutes(days[4].items[3].time)).toBeGreaterThanOrEqual(minutes(days[4].items[2].time) + 20); // dinner moved only as far as it had to
    expect(days[6].items[1].time).toBe("10:30");
    expect(notes.join(" ")).toMatch(/Hotel check-in Turin" moved from 13:15 to 1[56]:\d\d \(getting there from Lunch in Chamonix 06-14 takes about 2 h/);
    // A stop is never pushed past the ride that leaves after it: the ferry back at 16:00 caps what a mislocated
    // morning stop could be moved to.
    const ferryDay = goodPlan();
    ferryDay[6].items = [stop("08:30", "Turin → Isola Bella (ferry)", "transfer", { lat: 45.89, lng: 8.52 }, { durationMinutes: 60 }), stop("10:00", "Island walk", "sight", { lat: 45.89, lng: 8.52 }), stop("11:00", "Mainland church", "sight", TURIN), stop("16:00", "Isola Bella → Turin (ferry)", "transfer", TURIN, { durationMinutes: 60 }), stop("19:00", "Dinner 06-16", "meal", TURIN)];
    shiftTimes(ferryDay, await context(ferryDay));
    expect(minutes(ferryDay[6].items[2].time)).toBeLessThanOrEqual(16 * 60);
    expect(validatePlan(days, await context(days)).filter((x) => x.code === "no-time-between" || x.code === "overlap")).toEqual([]);
    // Nothing is pushed into the night: a stop that could only start after 21:00 stays where it is (for the model).
    const late = goodPlan();
    late[4].items[2].time = "20:50"; late[4].items[3].time = "20:45"; // dinner could only start at 21:10
    expect(shiftTimes(late, await context(late))).toEqual([]);
    expect(late[4].items[3].time).toBe("20:45");
  });
  it("takes a stop named after the town and as long as the drive there ('Vienna City Center' for three hours) as the drive", async () => {
    const ctx = await context();
    const days = goodPlan();
    days[2].items.splice(1, 0, stop("09:45", "Annecy City Center", "sight", ANNECY, { durationMinutes: 105, transport: "Drive, 1 h 45 min" }));
    days[3].items.splice(0, 1, stop("09:00", "Annecy Old Town", "sight", ANNECY, { durationMinutes: 120 }));
    dropStandIns(days, ctx);
    expect(days[2].items[1].kind).toBe("transfer");
    expect(days[3].items[0].kind).toBe("sight"); // a real visit of a town's old town on a full day stays
  });
  it("keeps travel days light and day trips off them", async () => {
    const days = goodPlan();
    days[2].items.push(stop("16:30", "Castle 06-12", "sight", ANNECY), stop("17:30", "Cathedral 06-12", "sight", ANNECY));
    days[7].items.push(stop("16:30", "Portofino", "sight", { lat: 44.3036, lng: 9.2097 }), stop("17:00", "Cinque Terre", "sight", { lat: 44.1461, lng: 9.6439 }));
    const found = validatePlan(days, await context(days));
    expect(found.filter((x) => x.code === "travel-day-heavy").map((x) => x.date)).toEqual(["2030-06-12", "2030-06-17"]);
    // Cinque Terre is far from Turin and Genoa and off the road between them; Portofino (~25 km from Genoa) is near.
    expect(found.filter((x) => x.code === "day-trip-on-travel-day").map((x) => x.message.slice(0, 14))).toEqual(['"Cinque Terre"']);
  });
  it("wants the must-see on its travel day, never a skipped place, and the day to end where they sleep", async () => {
    const days = goodPlan();
    // Only lunch "near the pass" left: driving towards a must-see isn't seeing it.
    days[4].items = days[4].items.filter((x) => !/^Chamonix$/.test(x.place)).map((x) => (x.kind === "meal" && /Chamonix/.test(x.place) ? { ...x, place: "Lunch near the pass" } : x));
    days[0].items.push(stop("16:00", "Tourist Trap Museum", "sight", LYON));
    days[5].items.push(stop("20:30", "Late dinner 06-15", "meal", GENOA));
    const found = validatePlan(days, await context(days));
    expect(found.find((x) => x.code === "must-see-missing")).toMatchObject({ date: "2030-06-14", severity: "repair" });
    // Lunch near the must-see doesn't count as seeing it either.
    const lunchOnly = goodPlan();
    lunchOnly[4].items = lunchOnly[4].items.filter((x) => !/^Chamonix$/.test(x.place)).map((x) => (x.kind === "meal" && /Chamonix/.test(x.place) ? { ...x, place: "Lunch near Chamonix" } : x));
    expect(validatePlan(lunchOnly, await context(lunchOnly)).some((x) => x.code === "must-see-missing")).toBe(true);
    expect(found.find((x) => x.code === "skip-place")).toMatchObject({ date: "2030-06-10" });
    expect(found.find((x) => x.code === "wrong-base")).toMatchObject({ date: "2030-06-15" });
  });
  it("flags departure times nobody looked up, not ones the timetable gave", () => {
    const ferry = stop("08:00", "Piombino → Portoferraio (car ferry)", "transfer", LYON, { transport: "Drive to the port, take the 08:30 car ferry" });
    expect(unverifiedTimes(ferry, "")).toEqual(["08:30"]);
    expect(unverifiedTimes(ferry, "- Piombino → Portoferraio: ferry 08:30, 1 h")).toEqual([]);
    expect(unverifiedTimes(stop("10:00", "Museum", "sight", LYON, { description: "Opens 09:00, closes 18:00" }), "")).toEqual([]);
  });
  it("warns about a thin full day or an unknown price, but an empty full day must be rewritten", async () => {
    const days = goodPlan();
    days[5].items = [stop("09:00", "Royal Palace", "sight", TURIN, { durationMinutes: 210, cost: undefined }), ...days[5].items.filter((x) => x.kind === "meal")];
    days[6].items = days[6].items.filter((x) => x.kind === "meal");
    const found = validatePlan(days, await context(days));
    expect(found.filter((x) => x.date === "2030-06-15").map((x) => `${x.code}:${x.severity}`).sort()).toEqual(["cost-unknown:warn", "full-day-thin:warn"]);
    expect(found.filter((x) => x.date === "2030-06-16").map((x) => x.code)).toContain("full-day-empty");
    expect(found.find((x) => x.code === "full-day-empty")!.severity).toBe("repair");
  });
  it("wants check-in first after arriving", async () => {
    const days = goodPlan();
    days[2].items.splice(1, 0, stop("12:00", "Old castle", "sight", ANNECY, { durationMinutes: 30 }));
    days[2].items[2].time = "12:45";
    expect(validatePlan(days, await context(days)).filter((x) => x.code === "late-check-in").map((x) => x.date)).toEqual(["2030-06-12"]);
  });
  it("objects to the car in town only when they'd rather leave it parked", async () => {
    const days = goodPlan();
    days[0].items[1].transport = "10 min drive, park at the Terreaux garage";
    expect(codes(validatePlan(days, await context(days, { getAround: "car" })))).not.toContain("car-in-town");
    days[2].items[1].transport = "Drive from Lyon, 1 h 45 min (131 km); park at the lake garage"; // the drive into town is no in-town driving
    expect(validatePlan(days, await context(days, { getAround: "mixed" })).filter((x) => x.code === "car-in-town" && x.date === "2030-06-12")).toEqual([]);
    const found = validatePlan(days, await context(days, { getAround: "mixed" })).filter((x) => x.code === "car-in-town");
    expect(found).toMatchObject([{ date: "2030-06-10", item: 1 }]);
  });
  it("knows when a place from OpenStreetMap is closed, and moves one that opens a little later", async () => {
    const days = goodPlan();
    days[6].items[1] = stop("11:00", "Museo Egizio", "sight", TURIN); // 2030-06-16 is a Sunday
    days[5].items[0] = stop("09:00", "Museo Egizio", "sight", TURIN); // a Saturday, opens at 10:00 (next stop at 11:00)
    const ctx = await context(days);
    for (const k of ["2030-06-16#1", "2030-06-15#0"]) ctx.located!.set(k, { ...ctx.located!.get(k)!, hours: "Mo-Sa 10:00-18:00", cc: "IT" });
    const found = validatePlan(days, ctx);
    expect(found.find((x) => x.code === "closed-then")).toMatchObject({ date: "2030-06-16", item: 1 });
    expect(quickFixHours(days, ctx).join(" ")).toMatch(/moved from 09:00 to 10:00/);
    expect(days[5].items[0].time).toBe("10:00");
    expect(validatePlan(days, ctx).filter((x) => x.date === "2030-06-15" && /opens|closed/.test(x.code))).toEqual([]);
  });
  it("scores a rewrite: fewer and smaller problems is better", () => {
    expect(score([{ code: "a", severity: "repair", message: "" }])).toBeLessThan(score([{ code: "a", severity: "repair", message: "" }, { code: "b", severity: "warn", message: "" }]));
    expect(score([{ code: "a", severity: "hard", message: "" }])).toBeGreaterThan(score(Array(9).fill({ code: "a", severity: "repair", message: "" })));
  });
});

describe("drives and rides as the page gets them", () => {
  it("folds drives and walks written as stops into the stop they lead to, keeping rides and a drive that ends the day", () => {
    const day: Day = { date: "2030-06-15", city: "Turin", title: "", estimatedCost: 0, items: [
      stop("08:30", "Hotel → Venaria Palace (Car)", "transfer", TURIN, { transport: "Drive, 25 min", cost: 5 }),
      stop("09:00", "Venaria Palace", "sight", TURIN, { transport: "Walk from the car park, 5 min", cost: 20 }),
      stop("12:00", "Venaria Palace → Lunch", "transfer", TURIN, { transport: "Walk, 5 min", cost: 0 }),
      stop("12:15", "Lunch near the palace", "meal", TURIN),
      stop("14:00", "Piombino → Portoferraio (ferry)", "transfer", TURIN, { transport: "Car ferry" }),
      stop("15:00", "Portoferraio", "sight", TURIN),
      stop("17:00", "Annecy → Turin (Car)", "transfer", TURIN, { transport: "Car", durationMinutes: 150 }), stop("19:30", "Turin old town", "sight", TURIN),
      stop("21:00", "Turin → Genoa (car)", "transfer", GENOA)] };
    const notes = foldTransfers([day]);
    expect(day.items.map((x) => x.place)).toEqual(["Venaria Palace", "Lunch near the palace", "Piombino → Portoferraio (ferry)", "Portoferraio", "Turin old town", "Turin → Genoa (car)"]);
    expect(day.items[0]).toMatchObject({ transport: "Drive, 25 min; Walk from the car park, 5 min", cost: 25 });
    expect(day.items[4].transport).toBe("Car, 2 h 30 min; Walk, 10 min");
    expect(notes).toHaveLength(3);
  });
  it("writes the drive between towns into the first stop there, with the routed time, and names the day's towns", async () => {
    const days = goodPlan();
    const ctx = await context(days);
    const trip = fixtureTrip();
    const d = days[4];
    const notes = finishDay(d, ctx.frames[4], trip, ctx.located!);
    expect(d.city).toBe("Annecy / Chamonix / Turin");
    expect(d.items[0].transport).toMatch(/^Drive from Annecy, 1 h \d\d min \(\d+ km\)$/);
    expect(d.items[2].transport).toMatch(/^Drive from Chamonix, [12] h \d\d min \(\d+ km\)$/);
    expect(d.items[1].transport).toBe("Walk, 10 min");
    expect(notes).toEqual([]);
    // Parking notes survive; a day that ends with the drive gets it as a stop of its own.
    const e = days[2];
    e.items[1].transport = "Drive, 2 h; park at the lake garage";
    finishDay(e, ctx.frames[2], trip, ctx.located!);
    expect(e.items[1].transport).toMatch(/^Drive from Lyon, .*; park at the lake garage$/);
    const g = days[7]; g.items = [stop("09:00", "Hotel check-out", "other", TURIN, { durationMinutes: 15 })];
    ctx.located!.set(spotKey(g.date, 0), { lat: TURIN.lat, lng: TURIN.lng, how: "stay", name: "Turin" });
    expect(finishDay(g, ctx.frames[7], trip, ctx.located!).join(" ")).toMatch(/added the drive Turin → Genoa/);
    expect(g.items[1]).toMatchObject({ place: "Turin → Genoa (car)", kind: "transfer", time: "09:15", lat: GENOA.lat, fixed: true });
  });
});

describe("scoring a finished plan", () => {
  it("adds up costs in code and notices totals the model got wrong", async () => {
    const days = goodPlan();
    const ctx = await context(days);
    for (const d of days) d.estimatedCost = d.items.reduce((n, x) => n + (x.cost || 0), 0);
    days[0].estimatedCost = 999;
    const it: Itinerary = { summary: "", totalEstimatedCost: 0, days, localCurrency: "EUR", unused: [] };
    const m = evaluatePlan(it, ctx, fixtureTrip().holidays);
    expect(m).toMatchObject({ datesCovered: 9, expectedDays: 9, costMismatches: 1, mustSee: { total: 1, planned: 1, silentlyMissing: 0 }, hasLocalCurrency: true, located: { none: 0 } });
    expect(m.hopsRouted).toBeGreaterThan(0);
  });
  it("counts a holiday mentioned on a day they're in another country", async () => {
    const days = goodPlan();
    days[3].notes = "The Invented Italian Day is today but doesn't matter in France.";
    const m = evaluatePlan({ summary: "", totalEstimatedCost: 0, days }, await context(days), fixtureTrip().holidays);
    expect(m.holidaysElsewhere).toBe(1);
  });
});

describe("which planner runs", () => {
  it("the checked one for whole new plans and the page's fix round, not for re-plans and changes", () => {
    const trip = fixtureTrip();
    expect(usesChecked(trip, "checked")).toBe(true);
    expect(usesChecked(trip, "standard")).toBe(false);
    expect(usesChecked({ ...trip, redoDay: { itinerary: { days: [] } as any, day: 0 } } as any, "checked")).toBe(false);
    expect(usesChecked({ ...trip, fix: { itinerary: { days: [] } as any, problems: [] } } as any, "checked")).toBe(true);
  });
  it("and the page's own checks ask the same day size of its plans", () => {
    const day = (n: number) => ({ date: "2030-06-11", city: "", title: "", estimatedCost: 0, items: [
      ...Array.from({ length: n }, (_, i) => ({ time: `1${i}:00`, place: `Sight ${i}`, kind: "sight" as const, description: "" })),
      { time: "12:30", place: "Lunch", kind: "meal" as const, description: "" }, { time: "19:00", place: "Dinner", kind: "meal" as const, description: "" }] });
    const it = { summary: "", totalEstimatedCost: 0, days: [day(1), day(3), day(1)].map((d, i) => ({ ...d, date: `2030-06-1${i}` })) };
    const stays = [{ start: "2030-06-10", nights: 2 }];
    expect(planGaps(it, stays, "balanced", false)).toHaveLength(1); // 3 sights is thin for the usual planner
    expect(planGaps({ ...it, days: [it.days[0], day(3), it.days[2]].map((d, i) => ({ ...d, date: `2030-06-1${i}` })) }, stays, "balanced", true)).toHaveLength(0);
  });
});
