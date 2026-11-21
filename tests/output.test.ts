import { describe, expect, it } from "vitest";
import { daysWritten, normalizeItinerary, parseJsonLoose, partialNotes } from "../server/ai/output";

describe("model output", () => {
  it("finds JSON in fences and chatter", () => {
    expect(parseJsonLoose('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(parseJsonLoose("no json")).toBeNull();
  });
  it("reads planning notes while they stream", () => {
    expect(partialNotes('{"planningNotes": "Kyoto first\\nthen Na')).toBe("Kyoto first\nthen Na");
    expect(partialNotes('{"days": [')).toBeNull();
  });
  it("counts days written so far", () => {
    expect(daysWritten('{"days":[{"date":"2026-01-01"},{"date": "2026-01-02"')).toBe(2);
  });
  it("tidies sloppy itineraries", () => {
    const it = normalizeItinerary({
      days: [{ date: "2026-01-01", items: [
        { time: "Morning stroll", place: "Park (35.01, 135.7)", cost: 5 },
        { time: "12:00", place: "Lunch", group: "All", people: 2, cost: 20 },
        { time: "13:00" },
      ] }],
    }, 2)!;
    const [a, b] = it.days[0].items;
    expect(it.days[0].items).toHaveLength(2);
    expect(a.time).toBe("");
    expect(a.description).toBe("Morning stroll.");
    expect(a.place).toBe("Park");
    expect(b.group).toBeUndefined();
    expect(it.days[0].estimatedCost).toBe(25);
    expect(it.totalEstimatedCost).toBe(25);
  });
  it("rejects answers without days", () => {
    expect(normalizeItinerary({ summary: "x" })).toBeNull();
  });
});

import { normalizeItinerary as norm2 } from "../server/ai/output";
describe("didn't fit", () => {
  it("drops places that are in the plan or said to be included", () => {
    const it = norm2({ days: [{ date: "d", items: [{ place: "Chiesa di Sant'Alessandro", description: "" }] }], unused: [
      { place: "Chiesa di Sant'Alessandro", reason: "x" },
      { place: "Duomo", reason: "Included on Sep 17 (Milan) - this is a MUST SEE and is covered." },
      { place: "Far castle", reason: "Too far from every stay." },
    ] })!;
    expect(it.unused!.map((u) => u.place)).toEqual(["Far castle"]);
  });
});
