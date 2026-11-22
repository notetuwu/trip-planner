// Settings → Planning: the options change the prompt (language, descriptions, real places, lookups) and only valid
// values are kept.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Trip } from "../server/ai/types";

let buildPrompt: typeof import("../server/ai/prompt").buildPrompt;
let settings: typeof import("../server/settings");
beforeAll(async () => {
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-tune-"));
  settings = await import("../server/settings");
  ({ buildPrompt } = await import("../server/ai/prompt"));
});

const sight = (k: number) => ({ name: `Sight ${k}`, kind: "museum", extras: [], lat: 35, lng: 135 });
const trip = {
  dailyBudget: 150, currency: "EUR", travelers: 2, pace: "balanced", model: "default", interests: "", notes: "", list: "",
  extraPlaces: [], research: true, mustSee: [], mustSeeWho: {}, skip: [],
  stays: [{ city: "Kyoto", start: "2026-04-01", nights: 3, hotel: "" }],
  nearby: [{ city: "Kyoto", sights: Array.from({ length: 40 }, (_, k) => sight(k)), food: [] }],
} as unknown as Trip;
const sights = (p: string) => (p.match(/- Sight \d+ \(/g) || []).length;

describe("planning options", () => {
  it("default: English, normal descriptions, all the places", () => {
    settings.writeSettings({ tune: { ...settings.TUNE_DEFAULTS } });
    const p = buildPrompt(trip, [], { webTools: true });
    expect(p).not.toContain("Write all text for the travelers");
    expect(p).toContain("what to do there and why it's worth it");
    expect(sights(p)).toBe(40);
    expect(p).toContain("up to about 30 searches");
  });
  it("language, brief descriptions, fewer places and fewer lookups", () => {
    settings.writeSettings({ tune: { language: "Deutsch", detail: "brief", places: "fewer", lookups: 10 } });
    const p = buildPrompt(trip, [], { webTools: true });
    expect(p).toContain("in Deutsch. Keep the names of places as they are known locally");
    expect(p).toContain("one short sentence on what it is and why go");
    expect(sights(p)).toBe(12);
    expect(p).toContain("up to about 10 searches");
  });
  it("the budget is per person, with the group's total", () => {
    settings.writeSettings({ tune: { ...settings.TUNE_DEFAULTS } });
    const p = buildPrompt({ ...trip, budgetPer: "person", travelers: 2 } as Trip, [], {});
    expect(p).toContain("150 EUR per person per day, so 300 EUR a day for the group of 2");
    expect(buildPrompt(trip, [], {})).toContain("150 EUR per day for 2 traveler(s)");
  });
  it("keeps only valid values", () => {
    settings.writeSettings({ tune: { ...settings.TUNE_DEFAULTS } });
    const s = settings.writeSettings({ tune: { detail: "huge", lookups: 999, temperature: 3, keepAlive: "forever", language: "<script>", fixRounds: "2" } as any });
    expect(s.tune).toMatchObject({ detail: "normal", lookups: 30, temperature: 0.4, keepAlive: "5m", language: "", fixRounds: 2 });
    expect(settings.keepAlive("-1")).toBe(-1);
    expect(settings.keepAlive("30m")).toBe("30m");
  });
  it("research: which pages may be opened and the search engine; the Brave key and SearXNG address", () => {
    const s = settings.writeSettings({ braveKey: "  key123  ", searxngUrl: "http://192.168.1.20:8080/", tune: { pages: "any", search: "bogus" } as any });
    expect(s.tune.pages).toBe("any");
    expect(s.tune.search).toBe("auto");
    expect(s.braveKey).toBe("key123");
    expect(s.searxngUrl).toBe("http://192.168.1.20:8080");
    expect(settings.writeSettings({ searxngUrl: "not a url" }).searxngUrl).toBe("http://192.168.1.20:8080");
    expect(settings.writeSettings({ tune: { pages: "found", search: "brave" } }).tune).toMatchObject({ pages: "found", search: "brave" });
  });
});
