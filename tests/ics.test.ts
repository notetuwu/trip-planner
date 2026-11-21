import { describe, expect, it } from "vitest";
import type { Itinerary } from "../shared/types";
import { itineraryIcs } from "../web/src/export/ics";

const trip: Itinerary = {
  summary: "", destination: "Japan", totalEstimatedCost: 0,
  days: [{
    date: "2026-04-02", city: "Kyoto", title: "Temples", estimatedCost: 0, notes: "Busy; go early",
    items: [
      { time: "09:00", place: "Fushimi Inari", description: "Gates, lots of them. ".repeat(8), transport: "JR Nara line, 5 min" },
      { time: "11:30", place: "Lunch", description: "" },
      { time: "", place: "Free time", description: "" },
      { time: "14:00", place: "Museum", description: "", group: "Group A" },
      { time: "14:30", place: "Shopping", description: "", group: "Group B" },
      { time: "16:00", place: "Gion walk", description: "" },
    ],
  }],
};

describe("calendar export", () => {
  const ics = itineraryIcs(trip, { now: new Date("2026-01-01T00:00:00Z") });
  const unfolded = ics.replace(/\r\n /g, "");
  const events = unfolded.split("BEGIN:VEVENT").slice(1);
  it("is a calendar with CRLF line endings", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });
  it("has an all-day event per day and one per timed stop", () => {
    expect(events).toHaveLength(1 + 5);
    expect(events[0]).toContain("DTSTART;VALUE=DATE:20260402");
    expect(events[0]).toContain("DTEND;VALUE=DATE:20260403");
    expect(events[0]).toContain("DESCRIPTION:Busy\\; go early");
  });
  it("ends a stop when the next one starts, keeping split groups apart", () => {
    expect(events[1]).toContain("DTSTART:20260402T090000");
    expect(events[1]).toContain("DTEND:20260402T113000");
    expect(events[3]).toContain("DTEND:20260402T160000"); // Group A's museum runs until everyone meets again
    expect(events[3]).toContain("SUMMARY:Museum (Group A)");
  });
  it("escapes commas and folds long lines", () => {
    expect(events[1]).toContain("Gates\\, lots of them");
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
});
