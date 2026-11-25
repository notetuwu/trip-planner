// A travel day's journey: its rides and check-out/check-in as runs (one card each), a stop on the way between them,
// and where new rides go in the day.
import { describe, expect, it } from "vitest";
import { insertAt, journeyRuns, journeySpan, namesRide } from "../web/src/itinerary/journey-model";

const s = (time: string, place: string, extra: Record<string, unknown> = {}) => ({ time, place, description: "", ...extra }) as any;
const isLeg = (x: any) => x.kind === "transfer" || / → /.test(x.place) || namesRide(x);

describe("a travel day's journey", () => {
  const day7 = [
    s("09:00", "Check out & Osaka Metro to Shin-Osaka", { kind: "transfer", cost: 6 }),
    s("12:15", "Shinkansen Shin-Osaka to Odawara", { kind: "sight", cost: 282 }),
    s("14:30", "Uber Odawara → Maple Stay Hotel", { kind: "transfer", cost: 125 }),
    s("16:13", "Arrive Maple Stay Hotel – check in"),
    s("17:00", "Rest at the hotel"),
  ];
  it("is one card from checking out to checking in, even with the Shinkansen stored as a sight", () => {
    const runs = journeyRuns(day7, isLeg);
    expect(runs).toEqual([{ items: [0, 1, 2, 3] }]);
    expect(journeySpan(day7, runs)).toEqual({ from: "09:00", to: "16:13", cost: 413 });
  });
  it("leaves a stop on the way between two cards", () => {
    const drive = [
      s("09:00", "Check out of Gasthof Isny"),
      s("09:15", "Drive Isny → Vaduz", { kind: "transfer" }),
      s("12:00", "Lunch in Vaduz", { kind: "meal" }),
      s("13:30", "Drive Vaduz → Lucerne", { kind: "transfer" }),
      s("16:00", "Kapellbrücke", { kind: "sight" }),
    ];
    expect(journeyRuns(drive, isLeg)).toEqual([{ items: [0, 1] }, { items: [3] }]);
  });
  it("needs a ride: checking out alone isn't a journey, and split groups stay as they are", () => {
    expect(journeyRuns([s("10:00", "Check out"), s("11:00", "Museum")], isLeg)).toEqual([]);
    expect(journeyRuns([s("10:00", "Bus to Nara", { kind: "transfer", group: "Group A" })], isLeg)).toEqual([]);
  });
  it("doesn't take a meal for a ride", () => {
    expect(namesRide(s("12:00", "Ekiben on the train", { kind: "meal" }))).toBe(false);
  });
  it("puts new rides in by time, or after checking out", () => {
    expect(insertAt(day7, "13:00")).toBe(2);
    expect(insertAt(day7, "")).toBe(1);
    expect(insertAt([s("18:00", "Dinner")], "")).toBe(0);
  });
});
