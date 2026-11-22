import { describe, expect, it } from "vitest";
import { routeFor, routeNote } from "../shared/route";
import { placeLines } from "../server/ai/prompt-sections";

const stays = [
  { city: "Salzburg", lat: 47.8095, lng: 13.055, start: "2027-09-11", nights: 3 },
  { city: "Padua", lat: 45.4064, lng: 11.8768, start: "2027-09-14", nights: 2 },
  { city: "Milano", lat: 45.4642, lng: 9.19, start: "2027-09-16", nights: 2 },
];

describe("must-sees on the route", () => {
  it("sees Sirmione as on the way from Padua to Milano", () => {
    const r = routeFor({ lat: 45.4917, lng: 10.6086 }, stays);
    expect(r.onWay).toBe(true);
    expect(r.leg).toMatchObject({ from: "Padua", to: "Milano", date: "2027-09-16" });
    expect(routeNote(r)).toMatch(/stop on that travel day/);
  });
  it("doesn't call a place next to a stay on the way", () => {
    const r = routeFor({ lat: 45.47, lng: 9.2 }, stays); // central Milan
    expect(r.onWay).toBe(false);
    expect(r.base?.city).toBe("Milano");
    expect(routeNote(r)).toBe("");
  });
  it("follows the travelers' choice", () => {
    const r = routeFor({ lat: 47.4796, lng: 13.1897 }, stays); // Hohenwerfen
    expect(routeNote({ ...r, how: "stay" })).toMatch(/from where they sleep \(nearest: Salzburg/);
    expect(routeNote({ ...r, how: "way" })).toMatch(/stop on the way between Salzburg and Padua/);
  });
  it("puts it in the place's line of the prompt", () => {
    const r = routeFor({ lat: 45.4917, lng: 10.6086 }, stays);
    const line = placeLines({ travelers: 2, mustSee: ["Castello"], mustSeeRoute: { Castello: r } } as any, [{ title: "Castello" } as any]);
    expect(line).toMatch(/\[MUST SEE - lies on the way between Padua and Milano/);
  });
});

describe("on the way of a day trip", () => {
  const osaka = { city: "Osaka", start: "2026-11-02", nights: 6, lat: 34.6937, lng: 135.5023, trips: [{ place: "Hiroshima", lat: 34.3853, lng: 132.4553 }] };
  const hakone = { city: "Hakone", start: "2026-11-08", nights: 2, lat: 35.2324, lng: 139.1069 };
  it("makes Onomichi a stop on the day trip to Hiroshima", () => {
    const r = routeFor({ lat: 34.4089, lng: 133.2050 }, [osaka, hakone]);
    expect(r.onTrip).toBe(true);
    expect(r.onWay).toBe(false);
    expect(r.trip).toMatchObject({ from: "Osaka", to: "Hiroshima" });
    expect(routeNote(r)).toContain("stop on that day trip");
    expect(routeNote({ ...r, how: "way" })).toContain("stop on the day trip from Osaka to Hiroshima");
  });
  it("leaves places off the day trip's way alone", () => {
    const r = routeFor({ lat: 35.0116, lng: 135.7681 }, [osaka, hakone]); // Kyoto
    expect(r.onTrip).toBe(false);
  });
});
