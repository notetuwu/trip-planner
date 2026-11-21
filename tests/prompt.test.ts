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
