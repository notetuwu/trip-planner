// A local model that stops mid-way (out of room, or stopped as stuck): the days it finished are read from its
// half-written JSON, so only the rest is asked for; and the itinerary JSON isn't mistaken for a loop.
import { describe, expect, it } from "vitest";
import { isLooping, jsonLoopGuard } from "../server/ai/loop-guard";
import { partialDays } from "../server/ai/output";

const day = (k: number) => ({ date: `2026-11-${String(k).padStart(2, "0")}`, city: "Kyoto", title: `Day ${k}`, estimatedCost: 100,
  items: [{ time: "08:00", place: "Breakfast at the hotel", description: "Included, {braces} and \"quotes\" inside." }, { time: "10:00", place: `Temple ${k}`, description: "Walk." }] });

describe("finished days in a half-written itinerary", () => {
  it("keeps the complete days and the fields before them, drops the half-written one", () => {
    const full = JSON.stringify({ planningNotes: "Notes", summary: "Kyoto week", destination: "Japan", days: [day(1), day(2), day(3)] });
    const cut = full.slice(0, full.indexOf('"Temple 3"'));
    const r = partialDays(cut)!;
    expect(r.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(r.head).toMatchObject({ summary: "Kyoto week", planningNotes: "Notes", destination: "Japan" });
    expect(r.days[0].items[0].description).toContain("{braces}");
  });
  it("nothing finished: null", () => {
    expect(partialDays('{"summary": "x", "days": [{"date": "2026-11-01", "items": [')).toBeNull();
    expect(partialDays('{"summary": "x"')).toBeNull();
  });
});

describe("loops", () => {
  it("a long itinerary with the same breakfast every morning isn't a loop", () => {
    const json = JSON.stringify({ days: Array.from({ length: 19 }, (_, k) => day(k + 1)) });
    const guard = jsonLoopGuard();
    let looped = false;
    for (let i = 0; i < json.length; i += 50) if (guard(json.slice(i, i + 50))) looped = true;
    expect(looped).toBe(false);
  });
  it("the same block written over and over is", () => {
    const block = JSON.stringify(day(1)).slice(0, 420);
    const guard = jsonLoopGuard();
    let looped = false;
    for (let k = 0; k < 40 && !looped; k++) looped = guard(block);
    expect(looped).toBe(true);
    expect(isLooping("Is it a fortress? No. ".repeat(30))).toBe(true);
  });
});
