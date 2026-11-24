// The trip chat checks distances instead of guessing them, and can take places off the must-see list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companionPrompt, parseChange, statesFigures } from "../server/trip/companion";

describe("distances in the chat", () => {
  it("spots distances and driving times, but not other numbers", () => {
    for (const t of ["about 350 km via the A8", "~3.5-4h to get there", "Stuttgart → Hohenzollern (~320-350 km, ~3.5-4h)", "2 hours of driving", "120 miles", "about 1.5 h"]) expect(statesFigures(t), t).toBe(true);
    for (const t of ["Day 3 has 4 stops", "Open from 9:00 to 18:00", "Tickets are 15 euro each", "a 10 min walk", "I'd mind that", "the 5th of May"]) expect(statesFigures(t), t).toBe(false);
  });
  it("tells the model to look every leg up and never write a distance from memory", () => {
    const p = companionPrompt({ model: "m", question: "x", days: 3 });
    expect(p).toContain("LOOKUP: route | Stuttgart | Hechingen | Lindau");
    expect(p).toContain("never state one from memory");
  });
});

describe("taking places off the must-see list", () => {
  it("reads removeMust as part of the trip's setup", () => {
    const c = parseChange('Done.\nCHANGE: {"days": [], "request": "", "trip": {"removeMust": ["Gaflei", " Vaduz Castle "]}}', 5);
    expect(c?.trip).toEqual({ removeMust: ["Gaflei", "Vaduz Castle"] });
    expect(companionPrompt({ model: "m", question: "x", days: 5 })).toContain('"removeMust"');
    expect(companionPrompt({ model: "m", question: "x", days: 0 })).toContain("removeMust");
  });
});

describe("a route through several places", () => {
  let runLookups: typeof import("../server/trip/chat-lookups").runLookups;
  beforeAll(async () => {
    process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-chat-"));
    vi.resetModules();
    vi.doMock("../server/geo/geocode", () => ({
      geocodeOne: async (q: string) => ({ lat: q.length, lng: q.length, label: q, name: q, country: "", cc: "", kind: "" }),
    }));
    vi.doMock("../server/geo/routing", () => ({ waitForRoute: async () => ({ d: 100_000, t: 3600 }) }));
    ({ runLookups } = await import("../server/trip/chat-lookups"));
  });
  afterAll(() => { vi.doUnmock("../server/geo/geocode"); vi.doUnmock("../server/geo/routing"); });

  it("adds up the legs", async () => {
    const out = await runLookups([{ kind: "route", args: ["Stuttgart", "Hechingen", "Lindau"] }], [], () => {});
    expect(out).toContain("Stuttgart → Hechingen: 100.0 km by road, about 1 h 0 min");
    expect(out).toContain("Total: 200.0 km, about 2 h 0 min driving");
  });
});
