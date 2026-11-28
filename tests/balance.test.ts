// How full each day is (the Balance window): what counts, what's measured or guessed, and what stands out.
import { describe, expect, it } from "vitest";
import { dayLoad, heavy, legLoad, limitsFor } from "../web/src/itinerary/balance";

const day = (items: { time: string; place: string; kind?: "transfer" | "meal" }[], estimatedCost = 0) => ({ date: "2030-05-01", city: "Town", title: "Town", estimatedCost, items: items.map((x) => ({ description: "", ...x })) });

describe("a day's load", () => {
  it("uses the route where there is one, and a guess from the straight distance where not", () => {
    expect(legLoad("foot", 1, { d: 1500, t: 1200 })).toEqual({ mode: "foot", km: 1.5, mins: 20, routed: true });
    const guess = legLoad("foot", 1, undefined);
    expect(guess.routed).toBe(false);
    expect(guess.km).toBeCloseTo(1.3);
    expect(guess.mins).toBeGreaterThan(15);
    // A train waits at the platform first; a mode nobody knows still gets a time.
    expect(legLoad("train", 80, null).mins).toBeGreaterThan(70);
    expect(legLoad("teleport", 10, null).mins).toBeGreaterThan(0);
  });

  it("adds up walking apart from riding, counts stops but not transfers, and spans the day's times", () => {
    const d = day([{ time: "9:00", place: "Castle" }, { time: "12:30", place: "Lunch", kind: "meal" }, { time: "14:00", place: "A → B (train)", kind: "transfer" }, { time: "19:00", place: "Dinner", kind: "meal" }], 120);
    const l = dayLoad(d, [legLoad("foot", 1, { d: 2000, t: 1500 }), legLoad("train", 30, { d: 31000, t: 1800 }), legLoad("foot", 0.5, undefined)]);
    expect(l).toMatchObject({ stops: 3, rideMin: 30, cost: 120, from: "09:00", to: "19:00", rough: true });
    expect(l.walkKm).toBeCloseTo(2.65);
    expect(dayLoad(day([]), [])).toMatchObject({ stops: 0, walkKm: 0, rideMin: 0, from: "", to: "", rough: false });
  });

  it("marks what's a lot for these travelers", () => {
    const lim = limitsFor("easy", "relaxed (2-3 main stops per day, late starts)", 100);
    expect(lim).toEqual({ walkKm: 6, rideMin: 180, stops: 6, budget: 100 });
    const l = { stops: 7, walkKm: 6.5, rideMin: 60, cost: 105, from: "", to: "", rough: false };
    expect(heavy(l, lim)).toEqual(["stops", "walk"]);
    expect(heavy({ ...l, stops: 3, walkKm: 2, rideMin: 200, cost: 150 }, lim)).toEqual(["ride", "cost"]);
    // No budget set: cost never stands out.
    expect(heavy({ ...l, cost: 9999 }, limitsFor("fit", "packed", 0))).toEqual([]);
  });
});
