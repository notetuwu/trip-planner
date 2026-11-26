// A day the travelers settled with the chat comes out as agreed: the chat sends the stops as a list, the planner is
// told to keep them, and any it leaves out (or tidies away as "only passing through") are put back.
import { describe, expect, it } from "vitest";
import { restoreAgreed } from "../shared/agreed";
import { parseChange } from "../server/trip/companion";
import { editSection } from "../server/ai/prompt";

const day7 = [
  { day: 7, date: "2026-11-08", time: "09:00", place: "Check out & Osaka Metro to Shin-Osaka", kind: "transfer" as const, cost: 6 },
  { day: 7, date: "2026-11-08", time: "12:15", place: "Shinkansen Shin-Osaka to Odawara", kind: "transfer" as const, cost: 282 },
  { day: 7, date: "2026-11-08", time: "14:30", place: "Uber from Odawara Station to Maple Stay hotel", kind: "transfer" as const, note: "About 40-60 min up Route 1." },
  { day: 7, date: "2026-11-08", time: "16:13", place: "Arrive at Maple Stay, check in" },
  { day: 7, date: "2026-11-08", time: "17:00", place: "Rest of the day at the hotel" },
];

describe("stops agreed in the chat", () => {
  it("keep where they are, for the map, when the name isn't the place", () => {
    const show = [{ day: 10, date: "2026-11-11", time: "11:30", place: "Studio Retro exhibition", where: "Shibuya BEAM, Udagawachō, Shibuya" }];
    const kept = { items: [{ time: "11:30", place: "Studio Retro exhibition", description: "Timed tickets." }] as { time: string; place: string; description: string; where?: string }[] };
    restoreAgreed(kept, show);
    expect(kept.items[0].where).toBe("Shibuya BEAM, Udagawachō, Shibuya");
    const missing = { items: [] as { time: string; place: string; description: string; where?: string }[] };
    restoreAgreed(missing, show);
    expect(missing.items[0].where).toBe("Shibuya BEAM, Udagawachō, Shibuya");
  });
  it("are put back when the planner's day is missing them, in time order", () => {
    const d = { items: [
      { time: "09:00", place: "Check out & Osaka Metro to Shin-Osaka", description: "With all luggage." },
      { time: "12:15", place: "Shinkansen Shin-Osaka to Odawara", description: "Hikari." },
    ] };
    expect(restoreAgreed(d, day7)).toBe(3);
    expect(d.items.map((x) => x.time)).toEqual(["09:00", "12:15", "14:30", "16:13", "17:00"]);
    expect(d.items[2]).toMatchObject({ place: "Uber from Odawara Station to Maple Stay hotel", kind: "transfer", description: "About 40-60 min up Route 1." });
    expect(d.items[1].description).toBe("Hikari."); // what the planner wrote stays
  });
  it("count as there under a slightly different name, so nothing is doubled", () => {
    const d = { items: [
      { time: "09:05", place: "Check out, metro to Shin-Osaka", description: "" },
      { time: "12:15", place: "Hikari Shinkansen to Odawara", description: "" },
      { time: "14:30", place: "Uber to the Maple Stay hotel", description: "" },
      { time: "16:15", place: "Check in at Maple Stay", description: "" },
      { time: "17:00", place: "Rest of the day at the hotel", description: "" },
    ] };
    expect(restoreAgreed(d, day7)).toBe(0);
    expect(d.items).toHaveLength(5);
  });
  it("come from the chat's change line, only for the days it changes", () => {
    const c = parseChange(`Day 7 becomes the travel day.\nCHANGE: {"days": [7], "request": "Replace all stops on Day 7.", "agreed": [
      {"day": 7, "time": "9:00", "place": "Check out & metro", "kind": "transport", "cost": 6},
      {"day": 7, "time": "12:15", "place": "Shinkansen to Odawara", "kind": "transfer"},
      {"day": 8, "time": "10:00", "place": "Not this day"},
      {"day": 7, "place": ""}]}`, 12);
    expect(c?.agreed).toEqual([
      { day: 7, time: "09:00", place: "Check out & metro", kind: "transfer", cost: 6 },
      { day: 7, time: "12:15", place: "Shinkansen to Odawara", kind: "transfer" },
    ]);
  });
  it("are given to the planner as the day's plan, to keep exactly", () => {
    const itinerary: any = { summary: "", totalEstimatedCost: 0, days: [{ date: "2026-11-08", city: "Osaka", title: "", estimatedCost: 0, items: [] }] };
    const text = editSection({ itinerary, days: [0], request: "Replace all stops.", agreed: day7 });
    expect(text).toContain("The stops they agreed on");
    expect(text).toContain('14:30 "Uber from Odawara Station to Maple Stay hotel"');
    expect(text).toContain("Don't leave any out");
    expect(editSection({ itinerary, days: [0], request: "x" })).not.toContain("agreed on");
  });
});

// Day 9: all four travel to the hotel together, then 1 stays in while 3 go for sushi, and the 3 split again.
const day9 = [
  { day: 9, date: "2026-11-10", time: "12:15", place: "Walk to hotel & check in" },
  { day: 9, date: "2026-11-10", time: "13:00", place: "Rest at the hotel", group: "Group A", people: 1 },
  { day: 9, date: "2026-11-10", time: "14:12", place: "Kura Sushi, 西友 浅草ROX店", group: "Group B", people: 3 },
  { day: 9, date: "2026-11-10", time: "17:12", place: "Akihabara: hobbyshop & figure stores", group: "Group B2", people: 1 },
];

describe("a split day agreed in the chat", () => {
  it("comes from the change line with each stop's group", () => {
    const c = parseChange(`Day 9 split.\nCHANGE: {"days": [9], "request": "Rebuild Day 9.", "agreed": [
      {"day": 9, "time": "12:15", "place": "Walk to hotel & check in", "group": "All"},
      {"day": 9, "time": "14:12", "place": "Kura Sushi", "group": "Group B", "people": 3}]}`, 20);
    expect(c?.agreed).toEqual([
      { day: 9, time: "12:15", place: "Walk to hotel & check in" },
      { day: 9, time: "14:12", place: "Kura Sushi", group: "Group B", people: 3 },
    ]);
  });
  it("tells the planner who does what", () => {
    const itinerary: any = { summary: "", totalEstimatedCost: 0, days: [{ date: "2026-11-10", city: "Tokyo", title: "", estimatedCost: 0, items: [] }] };
    const text = editSection({ itinerary, days: [0], request: "Rebuild.", agreed: day9 });
    expect(text).toContain('"Kura Sushi, 西友 浅草ROX店" · group: "Group B", 3 people');
    expect(text).toContain('exactly that "group" and "people"');
  });
  it("keeps its groups even when the planner drops them, and the shared stops stay shared", () => {
    const d = { items: [
      { time: "12:15", place: "Walk to hotel & check in", description: "", group: "Group A" },
      { time: "14:12", place: "Kura Sushi, 西友 浅草ROX店", description: "Conveyor-belt sushi." },
    ] as any[] };
    expect(restoreAgreed(d, day9)).toBe(2);
    expect(d.items.map((x) => [x.place, x.group, x.people])).toEqual([
      ["Walk to hotel & check in", undefined, undefined],
      ["Rest at the hotel", "Group A", 1],
      ["Kura Sushi, 西友 浅草ROX店", "Group B", 3],
      ["Akihabara: hobbyshop & figure stores", "Group B2", 1],
    ]);
  });
});

import { stopOps } from "../server/trip/companion";

describe("the chat's group edits", () => {
  it("set who does a stop already in the plan, or put everyone back together", () => {
    expect(stopOps([
      { op: "group", day: 9, place: "Kura Sushi", group: "Group B", people: 3 },
      { op: "group", day: 9, place: "Ueno Station", group: "" },
      { op: "add", day: 9, time: "17:12", place: "Back to hotel", group: "Group B1", people: 1 },
    ], 20)).toEqual([
      { op: "group", day: 9, place: "Kura Sushi", group: "Group B", people: 3 },
      { op: "group", day: 9, place: "Ueno Station", group: "" },
      { op: "add", day: 9, time: "17:12", place: "Back to hotel", description: "", where: "", cost: 0, kind: "sight", group: "Group B1", people: 1 },
    ]);
  });
});
