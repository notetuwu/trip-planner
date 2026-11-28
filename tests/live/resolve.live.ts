// Where the checked planner puts the stops of one day of a saved plan, with the real caches and services: to see why a
// pin went where it did. Run with `npm run test:live -- resolve` and:
//   TRIP_FILE  the saved trip (its stays and lists)      PLAN_FILE  an itinerary JSON (or a saved trip) to take the day from
//   DATE       the day (YYYY-MM-DD)                        OUT_FILE   where to write the result (outside the repo)
//   FRESH=1    forget the locations the stops already carry, so every one is looked up again
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { Place, TripRequest } from "../../shared/types";
import { prepareTrip, tripPlaces } from "../../server/routes/itinerary";
import { geoCached } from "../../server/ai/checked/planner";
import { buildFrames } from "../../server/ai/checked/frames";
import { routeFor } from "../../shared/route";
import type { MustSeeRoute } from "../../shared/types";
import { dayTowns, resolveDays } from "../../server/ai/checked/resolve";
import type { Trip } from "../../server/ai/types";

const FILE = process.env.TRIP_FILE || "", PLAN = process.env.PLAN_FILE || "", DATE = process.env.DATE || "", OUT = process.env.OUT_FILE || "";

describe.skipIf(!FILE || !PLAN || !DATE || !OUT)("where one day's stops are", () => {
  it("writes each stop's place and how it was found", async () => {
    const state = JSON.parse(fs.readFileSync(FILE, "utf8")).state;
    const marked = (m: string) => Object.keys(state.marks || {}).filter((t) => state.marks[t] === m);
    const trip = {
      stays: state.stays.map((s: any) => ({ city: s.city, start: s.start, nights: s.nights, hotel: s.hotel || "", travel: s.travel, dayTrips: s.dayTrips || [] })),
      dailyBudget: state.dailyBudget, budgetPer: state.budgetPer || "person", currency: state.currency, travelers: state.travelers, pace: state.pace,
      getAround: state.getAround, interests: state.interests, wishes: state.wishes, notes: state.notes, model: state.model, list: state.list || "", lists: state.lists || [],
      extraPlaces: (state.customPlaces || []).map(({ title, note, address, lat, lng }: any) => ({ title, note, address, lat, lng, picked: true })),
      research: false, bookings: [], mustSee: marked("must"), mustSeeWho: {}, skip: marked("skip"), people: state.people,
    } as unknown as TripRequest as Trip;
    const places: Place[] = await prepareTrip(trip, await tripPlaces(trip), null, () => {});
    // The must-sees' place on the route, as the page works it out (the stops on the way are towns of their day).
    const stayPts = trip.stays.map((s) => (typeof s.lat === "number" ? { city: s.city, start: s.start, nights: Number(s.nights), lat: s.lat, lng: s.lng! } : null));
    trip.mustSeeRoute = Object.fromEntries(trip.mustSee.map((t) => {
      const p = places.find((x) => x.title === t);
      const r: MustSeeRoute = p && typeof p.lat === "number" ? routeFor({ lat: p.lat, lng: p.lng! }, stayPts) : { onWay: false };
      return [t, { ...r, ...(state.how?.[t] ? { how: state.how[t] } : {}) }];
    }));
    const frames = buildFrames(trip, places);
    const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
    const days = plan.days || plan.state?.itinerary?.days || plan;
    const day = structuredClone(days.find((d: any) => d.date === DATE));
    if (process.env.FRESH) for (const x of day.items) { delete x.lat; delete x.lng; delete x.fixed; }
    const fi = frames.findIndex((f) => f.date === DATE);
    const towns = dayTowns(frames[fi], fi, frames, trip.stays);
    const { located, notes } = await resolveDays([day], { frames, stays: trip.stays, saved: places, nearby: trip.nearby || [], countries: [...new Set(trip.stays.map((s) => String(s.cc || "").toLowerCase()).filter(Boolean))].join(","), geo: geoCached });
    const lines = [`towns: ${towns.map((t) => `${t.name} ${t.lat.toFixed(3)},${t.lng.toFixed(3)}`).join(" | ")}`, `saved places: ${places.length}; nearby lists: ${(trip.nearby || []).map((n) => `${n.city} (${n.sights.length}+${n.food.length})`).join(", ")}`];
    day.items.forEach((x: any, i: number) => { const s = located.get(`${DATE}#${i}`); lines.push(`${i} ${x.place} => ${s ? `${s.how} "${s.name}" ${s.lat.toFixed(4)},${s.lng.toFixed(4)}` : "-"}`); });
    lines.push(...notes);
    fs.writeFileSync(OUT, lines.join("\n"));
    expect(day).toBeTruthy();
  }, 600_000);
});
