// The checked planner from start to finish against a fake Ollama (a scripted model on a local port), through the real
// askModel: the JSON schema sent as Ollama's format, a malformed answer asked again, an answer cut off and asked for in
// smaller parts, the stops located in code, the broken days (and only those) sent back, a rewrite kept only when it's
// better, a problem the model won't fix reported honestly, drives written from the frame, and costs, currency and
// holidays done in code. Then the page's fix round through the same planner. Plus the providers' schema fallbacks.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Day } from "../shared/types";
import { askModel, TruncatedError } from "../server/ai/ask";
import { fixChecked, planChecked } from "../server/ai/checked/planner";
import { CHAMONIX, LYON, TURIN, fakeGeo, fakeRoute, fixturePlaces, fixtureTrip, goodPlan, stop } from "./fixtures/checked-trip";

type Mode = "normal" | "old-ollama";
let mode: Mode = "normal";
const chats: { prompt: string; format: unknown; dates: string[] }[] = [];
let outlineCalls = 0, truncatedOnce = false, stubborn = false;

/** The plan the fake model writes first: a repeat on the 11th, dinner in Turin an hour after lunch in Chamonix on the
 *  14th (a 2.5 h drive), a boat time nobody looked up on the 16th, and a drive written as a stop on the 12th. */
function firstDraft(): Day[] {
  const days = goodPlan();
  days[0].items[0] = stop("09:00", "Basilica of Fourvière", "sight", LYON, { fromList: true });
  days[1].items.push(stop("16:30", "Basilica of Fourvière", "sight", LYON, { fromList: true }));
  days[2].items.splice(1, 0, stop("10:00", "Lyon → Annecy (car)", "transfer", LYON, { durationMinutes: 130, transport: "Drive, 2 h 10 min" }));
  days[4].items[2].time = "13:15"; days[4].items[3].time = "14:00";
  days[6].items[3] = stop("14:30", "Boat trip on the Po", "activity", TURIN, { description: "Take the 10:00 boat from Murazzi." });
  for (const d of days) { d.estimatedCost = 12345; d.items.sort((a, b) => a.time.localeCompare(b.time)); } // made-up totals: code adds them up itself
  return days;
}
/** What the fake model sends back when asked to fix days: the 11th and 14th fixed, the boat time left as it was. */
function fixed(date: string): Day {
  const days = firstDraft(), d = days.find((x) => x.date === date)!;
  if (date === "2030-06-11" && !stubborn) d.items = d.items.filter((x) => x.place !== "Basilica of Fourvière").concat(stop("16:30", "Croix-Rousse walk", "sight", LYON)).sort((a, b) => a.time.localeCompare(b.time));
  if (date === "2030-06-14") { d.items[2].time = "16:00"; d.items[3].time = "19:00"; }
  return d;
}

const outline = {
  destination: "France & Italy", summary: "Lakes, Alps and the Riviera.", planningNotes: "Chamonix on the way to Turin.", tips: ["Buy the Mont Blanc tunnel toll online."],
  days: goodPlan().map((d) => ({ date: d.date, title: d.city, theme: "", places: d.items.filter((x) => x.kind === "sight").map((x) => (x.place === "Chamonix" ? "Chamonix, France" : x.place)) })),
  unused: [], events: [{ date: "2030-06-16", name: "Lyon jazz night", where: "Lyon", impact: "fun" }, { date: "2030-06-15", name: "Turin market", where: "Turin", impact: "busy" }],
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/show") return res.end(JSON.stringify({ model_info: { "fake.context_length": 131072 } }));
    const b = JSON.parse(body);
    if (mode === "old-ollama" && b.format && typeof b.format === "object") { res.statusCode = 400; return res.end("invalid format"); }
    const prompt: string = b.messages[0].content;
    const dates = /with exactly these dates(?:, each complete)?: ([\d\-, ]+)/.exec(prompt)?.[1].split(", ").map((s) => s.trim()) || [];
    chats.push({ prompt, format: b.format, dates });
    const send = (content: string, reason = "stop") => { res.write(JSON.stringify({ message: { content } }) + "\n"); res.end(JSON.stringify({ done: true, done_reason: reason }) + "\n"); };
    if (mode === "old-ollama") return send('{"ok":true}');
    if (/only decides which day gets what/.test(prompt)) return send(++outlineCalls === 1 ? "Sure! Here is the outline you asked for." : JSON.stringify(outline));
    if (/^You are fixing/.test(prompt)) return send(JSON.stringify({ days: dates.map(fixed) }));
    if (/^You are writing/.test(prompt)) {
      if (dates.includes("2030-06-12") && dates.length > 1 && !truncatedOnce) { truncatedOnce = true; return send('{"days":[{"date":"2030-06-12","items":[', "length"); }
      return send(JSON.stringify({ days: firstDraft().filter((d) => dates.includes(d.date)) }));
    }
    send("{}");
  });
});
let base = "";
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); })));
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the checked planner, end to end", () => {
  it("plans, locates, checks, repairs only the broken days and reports what's left", async () => {
    const trip = { ...fixtureTrip(), model: `local|ollama|${base}|fake` };
    const events: any[] = [];
    const result = await planChecked(trip, fixturePlaces, (e) => events.push(e), new AbortController().signal, fakeRoute, fakeGeo);
    const it = result.itinerary;

    // Every request carried the JSON schema as Ollama's format, and never asked for coordinates.
    expect(chats.every((c) => typeof c.format === "object" && (c.format as any).type === "object")).toBe(true);
    expect(chats.some((c) => /"lat"/.test(JSON.stringify(c.format)))).toBe(false);
    // The malformed outline was asked again; the cut-off pair of days was asked for one day at a time.
    expect(outlineCalls).toBe(2);
    expect(chats.filter((c) => /^You are writing/.test(c.prompt)).map((c) => c.dates.join(","))).toEqual(
      ["2030-06-10,2030-06-11", "2030-06-12,2030-06-13", "2030-06-12", "2030-06-13", "2030-06-14,2030-06-15", "2030-06-16", "2030-06-17,2030-06-18"]);
    expect(result.checks).toMatchObject({ truncated: 1, enforced: chats.length, fallback: 0 });
    // Later batches are told what earlier days already use (the shared ledger).
    expect(chats.find((c) => c.dates[0] === "2030-06-14")!.prompt).toMatch(/Already used on other days[^\n]*\n[^\n]*Basilica of Fourvière/);
    // The routed drive times are in the prompts, with the must-see on the way.
    expect(chats.find((c) => c.dates[0] === "2030-06-14")!.prompt).toMatch(/Annecy → Chamonix 1 h 00 min[^\n]*Chamonix → Turin 1 h 59 min.*routing service/);

    // The check-in an hour's drive too early was moved in code (and the dinner with it, which then was in the
    // afternoon); only the broken days went back: first all three, then the one the model didn't fix.
    expect(result.checks!.fixedInCode.join(" ")).toMatch(/"Hotel check-in Turin" moved from 13:15 to 1[56]:\d\d \(getting there from Lunch in Chamonix 06-14 takes about 2 h/);
    expect(chats.filter((c) => /^You are fixing/.test(c.prompt)).map((c) => c.dates.join(","))).toEqual(["2030-06-11,2030-06-14,2030-06-16", "2030-06-16"]);
    const fixPrompt = chats.find((c) => /^You are fixing/.test(c.prompt))!.prompt;
    expect(fixPrompt).toMatch(/Basilica of Fourvière" is already planned on 2030-06-10/);
    expect(fixPrompt).toMatch(/"Dinner 06-14" at 1[56]:\d\d isn't a usual time/);
    expect(fixPrompt).not.toMatch(/getting there takes about 2 h/);
    const day = (date: string) => it.days.find((d) => d.date === date)!;
    expect(day("2030-06-11").items.map((x) => x.place)).toContain("Croix-Rousse walk");
    // Every full day still has lunch and dinner (code adds one when the model leaves it out; see the fixture).
    for (const d of it.days) if (d.items.length > 3) {
      const t = (x: { time: string }) => Number(x.time.slice(0, 2)) * 60 + Number(x.time.slice(3));
      expect(d.items.some((x) => x.kind === "meal" && t(x) >= 11 * 60 && t(x) <= 15 * 60 + 30), `${d.date} lunch`).toBe(true);
    }
    expect(day("2030-06-11").items.map((x) => x.place)).not.toContain("Basilica of Fourvière");
    expect(day("2030-06-14").items[2]).toMatchObject({ place: "Hotel check-in Turin", time: "16:00" });
    expect(result.checks!.daysRepaired).toBe(2);
    // The boat time nobody looked up: said so on the stop, and still listed as open.
    expect(day("2030-06-16").items.find((x) => /Boat/.test(x.place))!.description).toMatch(/not verified: check the current timetable/);
    expect(result.checks!.open.map((x) => `${x.code} ${x.date}`)).toEqual(["unverified-schedule 2030-06-16"]);
    expect(result.reasoning).toMatch(/Still open:\n.*2030-06-16/);

    // Where the stops are came from code: the saved place's own spot, lookups by name, the stay for hotel stops.
    expect(day("2030-06-14").items.find((x) => x.place === "Chamonix")).toMatchObject({ lat: CHAMONIX.lat, lng: CHAMONIX.lng, fromList: true, fixed: true });
    expect(day("2030-06-10").items.every((x) => typeof x.lat === "number" && x.fixed)).toBe(true);
    expect(day("2030-06-12").items.find((x) => /check-in/.test(x.place))).toMatchObject({ lat: 45.8992, lng: 6.1294, fixed: true });
    // The drive the model wrote as a stop is gone; the drives between towns are in the first stop there, from the frame.
    expect(day("2030-06-12").items.map((x) => x.place)).not.toContain("Lyon → Annecy (car)");
    expect(day("2030-06-12").items[1].transport).toMatch(/^Drive from Lyon, 1 h \d\d min \(1\d\d km\)$/);
    expect(day("2030-06-12").items.filter((x) => /^Drive from Lyon/.test(x.transport || ""))).toHaveLength(1);
    expect(day("2030-06-14").items[0].transport).toMatch(/^Drive from Annecy, 1 h 00 min/);
    expect(day("2030-06-14").city).toBe("Annecy / Chamonix / Turin");
    expect(day("2030-06-13").city).toBe("Annecy");

    // Assembled in code: totals from the stops, the currency, holidays only where they are, events in their stay.
    for (const d of it.days) expect(d.estimatedCost).toBe(d.items.reduce((n, x) => n + (x.cost || 0), 0));
    expect(it.totalEstimatedCost).toBe(it.days.reduce((n, d) => n + d.estimatedCost, 0));
    expect(it.localCurrency).toBe("EUR");
    expect(it.holidaysAndEvents!.map((h) => h.name)).toEqual(["Invented Regional Day", "Turin market"]);
    expect(it.days.map((d) => d.date)).toHaveLength(9);
    expect(result.engine).toMatch(/checked planner/);
    expect(result.reasoning).toMatch(/\d+ of \d+ stops located in code/);
    expect(events.some((e) => e.type === "progress" && e.days === 9)).toBe(true);
  });
});

describe("a repeat the model won't fix", () => {
  it("is left out in code when the day keeps enough without it", async () => {
    stubborn = true; outlineCalls = 1; truncatedOnce = true; chats.length = 0;
    const result = await planChecked({ ...fixtureTrip(), model: `local|ollama|${base}|fake` }, fixturePlaces, () => {}, new AbortController().signal, fakeRoute, fakeGeo);
    stubborn = false;
    const day = result.itinerary.days.find((d) => d.date === "2030-06-11")!;
    expect(day.items.filter((x) => x.place === "Basilica of Fourvière")).toHaveLength(0);
    expect(result.checks!.fixedInCode.join(" ")).toMatch(/2030-06-11: left out "Basilica of Fourvière", already planned on another day/);
    expect(result.checks!.open.map((x) => x.code)).not.toContain("duplicate-place");
  });
});

describe("the page's fix round", () => {
  it("goes through the same planner: only the named days come back, rewritten with the frame and real times", async () => {
    chats.length = 0;
    const itinerary = { summary: "", totalEstimatedCost: 0, days: firstDraft() };
    const trip = { ...fixtureTrip(), model: `local|ollama|${base}|fake`, fix: { itinerary, problems: [{ day: 1, text: '"Basilica of Fourvière" is on two days.' }] } };
    const result = await fixChecked(trip as any, fixturePlaces, () => {}, new AbortController().signal, fakeRoute, fakeGeo);
    expect(chats.filter((c) => /^You are fixing/.test(c.prompt)).map((c) => c.dates.join(","))).toEqual(["2030-06-11"]);
    expect(chats[0].prompt).toMatch(/Basilica of Fourvière" is on two days/);
    expect(result.itinerary.days.map((d) => d.date)).toEqual(["2030-06-11"]);
    expect(result.itinerary.days[0].items.map((x) => x.place)).toContain("Croix-Rousse walk");
    expect(result.itinerary.days[0].items.every((x) => typeof x.lat === "number")).toBe(true);
    expect(result.checks!.daysRepaired).toBe(1);
  });
});

describe("providers and the schema", () => {
  const schema = { name: "t", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } };
  it("an Ollama that takes no schema as its format is asked in plain JSON mode", async () => {
    mode = "old-ollama"; chats.length = 0;
    let enforced: boolean | undefined;
    const reply = await askModel(`local|ollama|${base}|fake`, "Answer.", () => {}, { schema, onFormat: (e) => { enforced = e; } });
    mode = "normal";
    expect(reply).toBe('{"ok":true}');
    expect(enforced).toBe(false);
    expect(chats.at(-1)!.format).toBe("json");
  });
  it("an answer cut off by the output limit is an error of its own (planned smaller, not retried as is)", async () => {
    truncatedOnce = false;
    await expect(askModel(`local|ollama|${base}|fake`, "You are writing\nwith exactly these dates: 2030-06-12, 2030-06-13", () => {}, { schema })).rejects.toBeInstanceOf(TruncatedError);
  });
});

describe("an OpenAI-compatible server (LM Studio, llama.cpp)", () => {
  const seen: any[] = [];
  let strictOk = true;
  const oai = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body); seen.push(b);
      if (b.response_format && !strictOk) { res.statusCode = 400; return res.end("response_format not supported"); }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  let url = "";
  beforeAll(() => new Promise<void>((r) => oai.listen(0, "127.0.0.1", () => { url = `http://127.0.0.1:${(oai.address() as AddressInfo).port}`; r(); })));
  afterAll(() => new Promise<void>((r) => oai.close(() => r())));
  const schema = { name: "t", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } };

  it("gets the schema as a strict json_schema response format", async () => {
    let enforced: boolean | undefined;
    expect(await askModel(`local|openai|${url}|m`, "Answer.", () => {}, { schema, onFormat: (e) => { enforced = e; } })).toBe('{"ok":true}');
    expect(seen.at(-1).response_format).toMatchObject({ type: "json_schema", json_schema: { name: "t", strict: true } });
    expect(enforced).toBe(true);
  });
  it("and without it when the server refuses it", async () => {
    strictOk = false;
    let enforced: boolean | undefined;
    expect(await askModel(`local|openai|${url}|m`, "Answer.", () => {}, { schema, onFormat: (e) => { enforced = e; } })).toBe('{"ok":true}');
    expect(seen.at(-1).response_format).toBeUndefined();
    expect(enforced).toBe(false);
  });
});
