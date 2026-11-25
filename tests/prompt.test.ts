import { describe, expect, it } from "vitest";
import type { Trip } from "../server/ai/types";
import { buildPrompt } from "../server/ai/prompt";

const trip = {
  dailyBudget: 150, currency: "EUR", travelers: 2, pace: "balanced", model: "default", interests: "", notes: "", list: "",
  extraPlaces: [], research: true, mustSee: [], mustSeeWho: {}, skip: [],
  stays: [{ city: "Kyoto", start: "2026-04-01", nights: 2, hotel: "" }],
} as Trip;
const itinerary = {
  summary: "", totalEstimatedCost: 0,
  days: ["2026-04-01", "2026-04-02", "2026-04-03"].map((date, i) => ({
    date, city: "Kyoto", title: `Day ${i + 1}`, estimatedCost: 0, items: [{ time: "10:00", place: `Temple ${i + 1}`, description: "" }],
  })),
};

describe("planning prompt", () => {
  it("asks Claude Code to research and write notes as text", () => {
    const p = buildPrompt(trip, [], { webTools: true });
    expect(p).toContain("Research online while you plan");
    expect(p).toContain("Then return the itinerary.");
    expect(p).not.toContain("## JSON schema");
  });
  it("names the output tool for the Anthropic API", () => {
    expect(buildPrompt(trip, [], { webTools: true, outputTool: "submit_itinerary" })).toContain("call the `submit_itinerary` tool");
  });
  it("puts notes in the JSON and the schema at the end for local models", () => {
    const p = buildPrompt(trip, [], { notes: "json", schema: true });
    expect(p).toContain('Start with "planningNotes"');
    expect(p).not.toContain("Research online while you plan");
    expect(p).toContain("## JSON schema");
  });
  it("asks for opening hours and booking info", () => {
    const p = buildPrompt(trip, []);
    expect(p).toContain('"booking"');
    expect(p).toContain("opening hours");
  });
  it("re-plans a single day with the rest as context", () => {
    const p = buildPrompt({ ...trip, redoDay: { itinerary, day: 1, request: "more food" } }, [], { webTools: true });
    expect(p).toContain("Re-plan 2026-04-02 (Kyoto). The travelers ask: more food");
    expect(p).toContain("2026-04-01 Kyoto: Temple 1");
    expect(p).toContain("2026-04-02 Kyoto: (this day)");
    expect(p).toContain('"days" containing only this one day');
  });
});

import { fixSection } from "../server/ai/prompt";
describe("fixing what the checks found", () => {
  it("sends only the affected days with their problems", () => {
    const day = (date: string, city: string, place: string) => ({ date, city, title: "", estimatedCost: 0, items: [{ time: "12:00", place, description: "" }] });
    const itinerary = { summary: "", totalEstimatedCost: 0, days: [day("2027-09-16", "Padua", "Duomo"), day("2027-09-17", "Milano", "Cafe Pedrocchi")] };
    const text = fixSection({ itinerary, problems: [{ day: 1, text: '"Cafe Pedrocchi" at 12:00: the only place of that name is in Padua' }] });
    expect(text).toMatch(/2027-09-16 Padua: Duomo/);
    expect(text).toMatch(/2027-09-17 Milano: \(to fix, below\)/);
    expect(text).toMatch(/- 2027-09-17: "Cafe Pedrocchi"/);
    expect(text).toMatch(/containing only the 1 day\(s\) to fix \(2027-09-17\)/);
  });
});

import { nearbySection } from "../server/ai/prompt-sections";
describe("nearby places for local models", () => {
  const poi = (name: string) => ({ name, kind: "museum", extras: [], lat: 1, lng: 2 });
  const list = (city: string) => ({ city, sights: Array.from({ length: 30 }, (_, i) => poi(`${city} sight ${i}`)), food: Array.from({ length: 30 }, (_, i) => poi(`${city} food ${i}`)) });
  const trip: any = { stays: [{ city: "Home", nights: 3 }, { city: "A", nights: 2 }, { city: "Airport", nights: 0 }, { city: "Home", nights: 0 }],
    nearby: [list("Home"), list("A"), list("Airport"), list("Home")] };
  it("keeps everything normally", () => {
    expect((nearbySection(trip).match(/sight \d+/g) || []).length).toBe(120);
  });
  it("compact: each town once, fewer places, few for pass-through stops", () => {
    const text = nearbySection(trip, true);
    expect((text.match(/### Home/g) || []).length).toBe(1);
    expect((text.match(/Airport sight/g) || []).length).toBe(4);
    expect((text.match(/A sight/g) || []).length).toBe(30);
    expect(text.length).toBeLessThan(nearbySection(trip).length / 2);
  });
});

import { localResearch } from "../server/research/research";
describe("researching one day", () => {
  it("names the stay that day is in, not the first one", async () => {
    const day = (date: string, city: string) => ({ date, city, title: "", estimatedCost: 0, items: [] });
    const itinerary = { summary: "", totalEstimatedCost: 0, days: [day("2027-09-10", "Home"), day("2027-09-13", "Salzburg")] };
    const trip: any = { travelers: 2, stays: [{ city: "Home", start: "2027-09-06", nights: 5 }, { city: "Salzburg", start: "2027-09-11", nights: 3 }],
      redoDay: { itinerary, day: 1, request: "" } };
    let prompt = "";
    await localResearch({ kind: "ollama", base: "http://127.0.0.1:9", model: "x", trip, places: [], abort: new AbortController().signal,
      onThinking: () => {}, tick: () => {}, onEvent: (e: any) => { if (e.type === "prompt" && !prompt) prompt = e.text; } }).catch(() => {});
    expect(prompt).toMatch(/2027-09-13 in Salzburg \(staying in Salzburg\)/);
  });
});

import { stayLines } from "../server/ai/prompt-sections";
describe("road routes in the prompt", () => {
  const stays = [{ city: "Tunis", start: "2027-07-05", nights: 3 }, { city: "Cape Town", start: "2027-07-08", nights: 2, travel: "car" }];
  it("tells the model the drive exists and how long it takes", () => {
    const text = stayLines({ stays, drives: { 1: { km: 10512, hours: 140.4 } } } as any);
    expect(text).toMatch(/a road route exists \(checked with a routing service\): 10,512 km, about 140 h of driving, i\.e\. at least 16 days/);
  });
  it("says so when there's no road", () => {
    expect(stayLines({ stays, drives: { 1: null } } as any)).toMatch(/no road route was found/);
  });
  it("says nothing when it wasn't checked", () => {
    expect(stayLines({ stays } as any)).not.toMatch(/routing service/);
  });
});

describe("a change to one day only gets what that day needs", () => {
  const poi = (name: string) => ({ name, kind: "museum", extras: [], lat: 1, lng: 2 });
  const day = (date: string, city: string, lat: number, lng: number) => ({ date, city, title: "", estimatedCost: 0, items: [{ time: "10:00", place: `Stop in ${city}`, description: "", lat, lng }] });
  const it2 = { summary: "", totalEstimatedCost: 0, days: [day("2027-09-06", "Isny", 47.58, 9.91), day("2027-09-12", "Lucerne", 47.05, 8.31)] };
  const base = {
    dailyBudget: 80, currency: "EUR", travelers: 2, pace: "balanced", model: "m", interests: "", notes: "", list: "", extraPlaces: [], research: false,
    mustSee: ["Gaflei"], mustSeeWho: {}, skip: [],
    stays: [{ city: "Isny", start: "2027-09-06", nights: 3 }, { city: "Lucerne", start: "2027-09-09", nights: 5 }],
    nearby: [{ city: "Isny", sights: [poi("Isny Burg")], food: [poi("Isny Linde")] }, { city: "Lucerne", sights: [poi("Lucerne Kapelle")], food: [poi("Lucerne Wolf")] }],
  } as unknown as Trip;
  const places = [
    { title: "Near Isny Cafe", lat: 47.6, lng: 9.9 }, { title: "Far Lucerne Museum", lat: 47.05, lng: 8.3 },
    { title: "Gaflei", lat: 47.14, lng: 9.54 }, { title: "No Location Idea" },
  ] as any;
  it("keeps the stay's lists and nearby saved places, and drops the rest of the trip's", () => {
    const edit = buildPrompt({ ...base, edit: { itinerary: it2, days: [0], request: "swap it" } }, places);
    expect(edit).toContain("Isny Burg");
    expect(edit).not.toContain("Lucerne Kapelle");
    expect(edit).toContain("Near Isny Cafe");
    expect(edit).toContain("Gaflei");
    expect(edit).toContain("No Location Idea");
    expect(edit).not.toContain("Far Lucerne Museum");
    expect(edit).not.toContain("Trip-wide extras");
    expect(edit).not.toContain("only interest part of the group");
    expect(edit.length).toBeLessThan(buildPrompt(base, places).length);
  });
  it("tells the planner what to do when the asked times can't work with the real drive", () => {
    expect(buildPrompt({ ...base, edit: { itinerary: it2, days: [0], request: "x" } }, places)).toContain("let the times follow the drive");
  });
  it("leaves a full plan alone", () => {
    const full = buildPrompt(base, places);
    expect(full).toContain("Lucerne Kapelle");
    expect(full).toContain("Trip-wide extras");
    expect(full).toContain("Far Lucerne Museum");
  });
  it("keeps the group-splitting rules when somebody splits", () => {
    const split = buildPrompt({ ...base, mustSeeWho: { Gaflei: 1 }, edit: { itinerary: it2, days: [0], request: "x" } }, places);
    expect(split).toContain("only interest part of the group");
  });
  it("keeps them when the change itself asks for a split day", () => {
    const ask = (request: string) => buildPrompt({ ...base, edit: { itinerary: it2, days: [0], request } }, places);
    expect(ask("Replace Day 1 with a split day (2 people + 1 person + 1 person)")).toContain('use "group"/"people"');
    expect(ask("Lunch at the cafe. Note: 2 of the 4 people.")).toContain('use "group"/"people"');
    expect(ask("swap the museum for a park")).not.toContain('use "group"/"people"');
  });
});
