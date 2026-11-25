// The trip chat checks distances instead of guessing them, and can take places off the must-see list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nameVariants } from "../server/trip/chat-lookups";
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
  const asked: string[] = [];
  // Nominatim knows the castle as "Hohenzollern Castle" only; every other name is a town (its distance is its name's length).
  const known: Record<string, [string, string]> = {
    "Hohenzollern Castle": ["48.3236", "8.9673"], Stuttgart: ["48.78", "9.18"], "Lindau": ["47.58", "9.91"],
  };
  beforeAll(async () => {
    process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-chat-"));
    vi.resetModules();
    vi.doMock("../server/geo/providers", async (orig) => ({
      ...(await orig<typeof import("../server/geo/providers")>()),
      nominatim: async (_: string, p: URLSearchParams) => {
        const q = p.get("q") || "";
        asked.push(q);
        const at = known[q];
        return at ? [{ lat: at[0], lon: at[1], name: q, display_name: `${q}, Germany`, category: "historic", type: "castle", address: { country: "Germany", country_code: "de" } }] : [];
      },
    }));
    vi.doMock("../server/geo/routing", () => ({ waitForRoute: async () => ({ d: 100_000, t: 3600 }) }));
    ({ runLookups } = await import("../server/trip/chat-lookups"));
  });
  afterAll(() => { vi.doUnmock("../server/geo/providers"); vi.doUnmock("../server/geo/routing"); });

  it("adds up the legs, and finds a castle under the name the map uses", async () => {
    const out = await runLookups([{ kind: "route", args: ["Stuttgart", "Schloss Hohenzollern, Hechingen, Germany", "Lindau"] }], [], () => {});
    expect(out).toContain("Stuttgart, Germany → Hohenzollern Castle, Germany: 100.0 km by road, about 1 h 0 min");
    expect(out).toContain("Total: 200.0 km, about 2 h 0 min driving");
    expect(asked).toContain("Hohenzollern Castle");
  });
  it("takes coordinates as they are", async () => {
    const out = await runLookups([{ kind: "route", args: ["48.3236,8.9673", "47.58, 9.91"] }], [], () => {});
    expect(out).toContain("48.3236, 8.9673 → 47.5800, 9.9100: 100.0 km by road");
  });
});

describe("other ways a name is written", () => {
  it("tries the name with only its country, in English, and alone", () => {
    expect(nameVariants("Schloss Hohenzollern, Hechingen, Germany")).toEqual([
      "Schloss Hohenzollern, Hechingen, Germany", "Hohenzollern Castle", "Schloss Hohenzollern, Germany", "Schloss Hohenzollern", "Hohenzollern Castle, Germany",
    ]);
    expect(nameVariants("Gaflei")).toEqual(["Gaflei"]);
    expect(nameVariants("Vaduz, Liechtenstein")).toEqual(["Vaduz, Liechtenstein", "Vaduz"]);
  });
});

import { webSources } from "../server/trip/chat-lookups";
describe("sources and modes", () => {
  it("lists the pages a web search found", () => {
    const text = "Hohenzollern Castle - official site\nhttps://www.burg-hohenzollern.com/\nOpening hours…\n\nTickets\nhttps://www.burg-hohenzollern.com/tickets\nPrices…";
    expect(webSources(text)).toEqual([
      { kind: "web", title: "Hohenzollern Castle - official site", url: "https://www.burg-hohenzollern.com/" },
      { kind: "web", title: "Tickets", url: "https://www.burg-hohenzollern.com/tickets" },
    ]);
  });
  it("keeps the change's headline", () => {
    expect(parseChange('Ok.\nCHANGE: {"title": "Hohenzollern instead of Nuremberg", "days": [1], "request": "Swap the castle"}', 5)?.title).toBe("Hohenzollern instead of Nuremberg");
  });
  it("Ask mode never offers a change", () => {
    const p = companionPrompt({ model: "m", question: "x", days: 5, mode: "ask" });
    expect(p).toContain("Ask mode");
    expect(p).not.toContain("CHANGE: {");
  });
});

import { tripOps, unverifiedFigures } from "../server/trip/companion";
describe("figures must come from the trip or a lookup", () => {
  const looked = "Stuttgart → Hohenzollern Castle: 465.2 km by road, about 4 h 53 min driving\nHohenzollern Castle → Lindau: 190.4 km by road, about 2 h 5 min driving";
  it("flags guessed figures and accepts looked-up ones (rounded, or the total of two legs)", () => {
    expect(unverifiedFigures("Stuttgart → Hohenzollern (~320-350 km, ~3.5-4h)", looked)).toEqual(["320-350 km", "3.5-4h"]);
    expect(unverifiedFigures("about 465 km and almost 5 h, then 190 km", looked)).toEqual([]);
    expect(unverifiedFigures("about 656 km in all, 7 h of driving", looked)).toEqual([]);
    expect(unverifiedFigures("Day 3 has 4 stops and costs 80 EUR", "")).toEqual([]);
  });
});

describe("costs for another number of travelers", () => {
  it("reads rescaleCosts, and only sensible numbers", () => {
    expect(tripOps({ rescaleCosts: { from: 1, to: 2 } })).toEqual({ rescaleCosts: { from: 1, to: 2 } });
    expect(tripOps({ rescaleCosts: { from: 2, to: 2 } })).toBeNull();
    expect(tripOps({ rescaleCosts: { from: 0, to: 99 } })).toBeNull();
  });
});

import { editOps } from "../server/trip/companion";
describe("edits and the trip's own data", () => {
  it("keeps well-formed edits only", () => {
    expect(editOps([{ op: "set", field: "travelers", value: 2 }, { op: "set", field: "password", value: "x" }, { op: "swapDays", day: 3, toDay: 9 }, { op: "nope" }, { op: "stayNights", stay: "Lucerne", nights: 4 }], 5))
      .toEqual([{ op: "set", field: "travelers", value: 2 }, { op: "stayNights", stay: "Lucerne", nights: 4 }]);
    expect(parseChange('Ok.\nCHANGE: {"days": [], "request": "", "edits": [{"op": "note", "value": "No drives over 4 hours"}]}', 5)?.edits).toEqual([{ op: "note", value: "No drives over 4 hours" }]);
  });
  it("answers LOOKUP: trip | topic from what the page sent", async () => {
    const out = await runLookupsFresh([{ kind: "trip", args: ["costs"] }, { kind: "trip", args: ["nonsense"] }], { costs: "Day 1: 97 EUR" });
    expect(out).toContain("Day 1: 97 EUR");
    expect(out).toContain('Nothing called "nonsense". There is: costs.');
  });
  it("lists the topics in the prompt", () => {
    expect(companionPrompt({ model: "m", question: "x", days: 3, data: { costs: "", checks: "" } })).toContain("LOOKUP: trip | costs");
  });
});
async function runLookupsFresh(l: any[], data: Record<string, string>) {
  const { runLookups: run } = await import("../server/trip/chat-lookups");
  return run(l, [], () => {}, [], data);
}

import { summaryText } from "../server/trip/companion";
describe("summaries and part-trip travelers", () => {
  it("turns a JSON summary into bullets", () => {
    expect(summaryText('{"summary": ["- Added Gaflei to the must-sees.", "Finalized 2 travelers"]}')).toBe("- Added Gaflei to the must-sees.\n- Finalized 2 travelers");
    expect(summaryText("- already bullets")).toBe("- already bullets");
  });
  it("reads rescaleCosts for some days, from a time", () => {
    expect(tripOps({ rescaleCosts: { from: 2, to: 3, days: [1, 2, 3], after: "14:00" } })).toEqual({ rescaleCosts: { from: 2, to: 3, days: [1, 2, 3], after: "14:00" } });
    expect(tripOps({ rescaleCosts: { from: 2, to: 3, after: "14:00" } })).toEqual({ rescaleCosts: { from: 2, to: 3 } });
  });
  it("sends far-away stops to the planner", () => {
    expect(companionPrompt({ model: "m", question: "x", days: 3 })).toContain('is a "request" for the planner for that day');
  });
});

describe("book ahead and packing from the chat", () => {
  it("keeps ticks, unticks and packing edits", () => {
    expect(editOps([{ op: "booked", item: "Stay in Lucerne", done: false }, { op: "packed", item: "Rain jacket", done: true }, { op: "packAdd", value: "Hiking poles" }, { op: "packRemove", value: "Hiking poles" }], 5))
      .toEqual([{ op: "booked", item: "Stay in Lucerne", done: false }, { op: "packed", item: "Rain jacket", done: true }, { op: "packAdd", value: "Hiking poles" }, { op: "packRemove", value: "Hiking poles" }]);
    expect(companionPrompt({ model: "m", question: "x", days: 3 })).toContain('{"op": "packed"');
  });
});

describe("how they get around, through the chat", () => {
  it("can set how they get to one stop, and how they get around", () => {
    expect(editOps([{ op: "transport", day: 2, place: "Morinomiya", value: "Osaka Metro Chuo Line from Hommachi, 10 min", mode: "metro" }, { op: "set", field: "getAround", value: "transit" }, { op: "transport", day: 9, place: "x" }], 5))
      .toEqual([{ op: "transport", day: 2, place: "Morinomiya", value: "Osaka Metro Chuo Line from Hommachi, 10 min", mode: "metro" }, { op: "set", field: "getAround", value: "transit" }]);
    // A whole trip's stops in one change.
    expect(editOps(Array.from({ length: 70 }, (_, k) => ({ op: "transport", day: 1, place: `Stop ${k}`, mode: "train" })), 5)).toHaveLength(60);
  });
  it("is told how to bring an older trip up to date", () => {
    const p = companionPrompt({ model: "m", question: "x", days: 3 });
    expect(p).toContain('{"op": "transport"');
    expect(p).toContain("Bring the trip up to date");
    expect(p).toContain('"getAround"');
  });
});

import { cleanAnswer, parseQuestion } from "../server/trip/companion";
describe("the chat's questions", () => {
  const reply = 'To update the transport I need to know how you got around.\nQUESTION: {"question": "How do you get around?", "options": ["Public transport and the odd taxi", "By car", "A mix"], "multi": false}';
  it("reads a question with answers to pick from, and keeps it out of the text", () => {
    expect(parseQuestion(reply)).toEqual({ q: "How do you get around?", options: ["Public transport and the odd taxi", "By car", "A mix"] });
    expect(cleanAnswer(reply)).toBe("To update the transport I need to know how you got around.");
  });
  it("hides a question still being written", () => {
    expect(cleanAnswer('To update it I need one thing.\nQUESTION: {"question": "How do')).toBe("To update it I need one thing.");
    expect(cleanAnswer("To update it I need one thing.\nQUES")).toBe("To update it I need one thing.");
  });
  it("needs a question and at least two answers", () => {
    expect(parseQuestion('QUESTION: {"question": "Which?", "options": ["Only one"]}')).toBeNull();
    expect(parseQuestion('QUESTION: {"question": "Which days?", "options": ["Day 1", "Day 2", "Day 2"], "multi": true}')).toEqual({ q: "Which days?", options: ["Day 1", "Day 2"], multi: true });
  });
  it("is told it can ask", () => expect(companionPrompt({ model: "m", question: "x", days: 3 })).toContain("QUESTION: {"));
});

import { promisesChange } from "../server/trip/companion";

describe("a reply that promises a change without one", () => {
  it("is spotted, so the chat asks for the change line", () => {
    expect(promisesChange("Sure – I'll set the map locations of all seven Group B stops on Day 4 to the same addresses.")).toBe(true);
    expect(promisesChange("Done – all seven Group B stops on Day 4 now have the same map locations as their Day 6 twins.")).toBe(true);
    expect(promisesChange("I’ve moved the castle to Day 3.")).toBe(true);
  });
  it("isn't confused with answers and suggestions", () => {
    expect(promisesChange("Kura Sushi opens at 11:00 and the walk from Namba is about 5 minutes.")).toBe(false);
    expect(promisesChange("You could move the castle to Day 3 if you like: want me to?")).toBe(false);
    expect(promisesChange("The shops now have winter hours.")).toBe(false);
  });
});
