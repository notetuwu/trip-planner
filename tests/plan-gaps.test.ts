// What a fresh plan is sent back for besides wrong or closed places: missing meals and thin full days; and legs
// without a chosen way of getting there on a road trip.
import { describe, expect, it } from "vitest";
import type { Itinerary, ItineraryItem } from "../shared/types";
import { researchPlaces } from "../server/ai/prompt-sections";
import type { Trip } from "../server/ai/types";
import { planGaps } from "../web/src/itinerary/gaps";
import { legModes } from "../web/src/trip/leg-default";

const item = (time: string, kind: ItineraryItem["kind"], place = `${kind} ${time}`) => ({ time, kind, place, description: "" });
const plan = (...days: ItineraryItem[][]) => ({
  days: days.map((items, i) => ({ date: `2027-09-0${i + 1}`, city: "Vienna", title: "", estimatedCost: 0, items })),
}) as unknown as Itinerary;
const stays = [{ start: "2027-09-01", nights: 2 }];
const fullDay = [item("09:00", "sight"), item("10:30", "sight"), item("12:30", "meal"), item("14:00", "activity"), item("16:00", "sight"), item("19:00", "meal")];

describe("missing from a plan", () => {
  it("nothing, with meals and enough to do; the last day needs no dinner", () => {
    expect(planGaps(plan([item("08:00", "transfer"), item("15:00", "sight"), item("19:00", "meal")], fullDay, [item("08:30", "transfer")]), stays, "balanced (3-5 stops per day)")).toEqual([]);
  });
  it("dinner on a travel day, and lunch, dinner and sights on a full day", () => {
    const gaps = planGaps(plan([item("14:00", "transfer")], [item("09:00", "meal"), item("10:00", "sight")], []), stays, "balanced");
    expect(gaps.map((g) => g.day)).toEqual([0, 1]);
    expect(gaps[0].text).toMatch(/missing: there is no dinner\./);
    expect(gaps[1].text).toMatch(/no lunch; there is no dinner; this full day has only 1 sight or activity \(at least 4/);
  });
  it("something to do on a travel day that is over early", () => {
    const [gap] = planGaps(plan([item("08:00", "transfer"), item("12:30", "meal"), item("18:30", "meal")], fullDay, []), stays, "balanced");
    expect(gap.text).toMatch(/missing: there is nothing to see or do/);
  });
  it("asks less of a relaxed day", () => {
    const three = fullDay.filter((x) => x.time !== "16:00");
    expect(planGaps(plan([item("19:00", "meal")], three, []), stays, "relaxed")).toEqual([]);
    expect(planGaps(plan([item("19:00", "meal")], three, []), stays, "balanced")).toHaveLength(1);
  });
});

describe("what research is told", () => {
  it("is the towns and dates, not the start address", () => {
    const trip = { stays: [
      { city: "Home Street 1", start: "2027-08-28", nights: 0 },
      { city: "Vienna", country: "Austria", start: "2027-08-28", nights: 2, travel: "car", hotel: "Hotel X", dayTrips: [] },
      { city: "Home Street 1", start: "2027-08-30", nights: 0, travel: "car" },
    ] } as unknown as Trip;
    expect(researchPlaces(trip)).toBe("Vienna (Austria) from 2027-08-28 (Sat), 2 night(s), arriving by car (they drive themselves)");
  });
});

describe("legs without a chosen way", () => {
  it("are driven when every chosen leg is by car; the start has none", () => {
    expect(legModes([{}, { travel: "" }, { travel: "car" }, { travel: "car" }])).toEqual(["", "car", "car", "car"]);
  });
  it("stay open otherwise", () => {
    expect(legModes([{}, {}, { travel: "car" }, { travel: "train" }])).toEqual(["", "", "car", "train"]);
    expect(legModes([{}, {}, {}], "car")).toEqual(["", "", ""]);
    expect(legModes([{}, {}, { travel: "car" }], "transit")).toEqual(["", "", "car"]);
  });
});
