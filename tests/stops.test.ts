import { describe, expect, it } from "vitest";
import { pointsAlong } from "../server/trip/stops";

describe("points along a route", () => {
  it("splits a route evenly by distance", () => {
    const line: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 4]];
    const [a, b] = pointsAlong(line, [0.25, 0.75]);
    expect(a[0]).toBeCloseTo(0); expect(a[1]).toBeCloseTo(1, 1);
    expect(b[1]).toBeCloseTo(3, 1);
  });
});

import { fitNights } from "../server/trip/route-plan";
describe("fitting nights to the trip length", () => {
  it("takes nights from the longest stays first", () => {
    const s = [{ nights: 3 }, { nights: 1 }, { nights: 2 }];
    fitNights(s, 4);
    expect(s.map((x) => x.nights)).toEqual([1, 1, 2]);
  });
  it("adds nights when there are too few", () => {
    const s = [{ nights: 1 }, { nights: 1 }];
    fitNights(s, 5);
    expect(s.reduce((n, x) => n + x.nights, 0)).toBe(5);
  });
  it("never goes below one night", () => {
    const s = [{ nights: 1 }, { nights: 1 }, { nights: 1 }];
    fitNights(s, 2);
    expect(s.map((x) => x.nights)).toEqual([1, 1, 1]);
  });
});

import { reasoningSoFar, untangle } from "../server/trip/route-plan";
describe("a route without doubling back", () => {
  it("reorders the middle stops of a zig-zag", () => {
    // Start, then east 3, east 1, east 2, end further east: 1 and 3 swap.
    expect(untangle([[0, 0], [0, 3], [0, 1], [0, 2], [0, 4]])).toEqual([0, 2, 3, 1, 4]);
  });
  it("keeps a route that already flows", () => {
    expect(untangle([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])).toEqual([0, 1, 2, 3, 4]);
  });
});
describe("the reasoning shown while a route is planned", () => {
  it("reads the half-written reasoning and the stays so far", () => {
    const reply = String.raw`{"reasoning": "Alps first,\nthen the lakes", "title": "x", "stays": [{"city": "Salzburg"}, {"city": "Hall`;
    expect(reasoningSoFar(reply, "")).toBe("Alps first,\nthen the lakes\n\nStays so far: Salzburg");
    expect(reasoningSoFar(String.raw`{"reasoning": "half \u00`, "hmm")).toBe("hmm\n\nhalf");
  });
});

import { mergeClose, placeTrips } from "../server/trip/route-plan";
const stay = (city: string, lat: number, lng: number, nights = 2, dayTrips: any[] = []) => ({ city, country: "", nights, travel: "car" as const, why: "", lat, lng, dayTrips });
describe("checking a planned route against the map", () => {
  it("merges a stay right next to one they named, keeping the named one", () => {
    const stays = [stay("Lindau", 47.55, 9.68, 3), stay("Lucerne", 47.05, 8.31), stay("Bregenz", 47.5, 9.75, 2, [{ place: "Pfänder", why: "" }])];
    mergeClose(stays, "visit friends in lindau and back");
    expect(stays.map((s) => [s.city, s.nights])).toEqual([["Lindau", 5], ["Lucerne", 2]]);
    expect(stays[0].dayTrips.map((t) => t.place)).toEqual(["Pfänder"]);
  });
  it("moves a day trip to the stay it's closest to", () => {
    // Neuschwanstein listed on a stay 40 km away, while Füssen (4 km) is a stay too.
    const stays = [stay("Kempten", 47.73, 10.31, 3, [{ place: "Neuschwanstein", why: "", lat: 47.557, lng: 10.75 }]), stay("Füssen", 47.57, 10.70, 2)];
    placeTrips([[48.1, 11.6], [47.73, 10.31], [47.57, 10.70], [48.1, 11.6]], stays);
    expect(stays[0].dayTrips).toEqual([]);
    expect(stays[1].dayTrips!.map((t) => t.place)).toEqual(["Neuschwanstein"]);
  });
  it("makes a sight they named between two stays a stop on that travel day", () => {
    // Vaduz on a day trip from Lucerne, though it lies on the drive from Lucerne to Bregenz.
    const stays = [stay("Lucerne", 47.05, 8.31, 3, [{ place: "Vaduz", why: "Liechtenstein", lat: 47.14, lng: 9.52 }]), stay("Bregenz", 47.5, 9.75, 2)];
    const via = placeTrips([[47.37, 8.54], [47.05, 8.31], [47.5, 9.75], [47.37, 8.54]], stays, "a day trip to vaduz");
    expect(stays[0].dayTrips).toEqual([]);
    expect(via.get(1)?.map((v) => v.place)).toEqual(["Vaduz"]);
  });
});

import { nameForms } from "../server/trip/route-plan";
describe("stops on the way and odd place names", () => {
  it("tries the name in brackets and the name without them, keeping the country", () => {
    expect(nameForms("Swiss Valley (Schwazer Land), Austria")).toEqual(["Swiss Valley (Schwazer Land), Austria", "Schwazer Land, Austria", "Swiss Valley, Austria"]);
    expect(nameForms("Vaduz, Liechtenstein")).toEqual(["Vaduz, Liechtenstein"]);
  });
  it("puts a place they asked to see on the way on the leg with the least detour", () => {
    const stays = [stay("Lucerne", 47.05, 8.31, 3, [{ place: "Vaduz, Liechtenstein", why: "", way: true, lat: 47.14, lng: 9.52 }]), stay("Bregenz", 47.5, 9.75, 2)];
    const via = placeTrips([[47.37, 8.54], [47.05, 8.31], [47.5, 9.75], [47.37, 8.54]], stays);
    expect(via.get(1)?.map((v) => v.place)).toEqual(["Vaduz, Liechtenstein"]);
    expect(stays.flatMap((s) => s.dayTrips || [])).toEqual([]);
  });
  it("keeps a nearby day trip the model came up with as a day trip, even when it's on the way", () => {
    // 35 km from Lucerne, just off the drive to Bregenz: an easy day out from the stay.
    const stays = [stay("Lucerne", 47.05, 8.31, 3, [{ place: "Lakeside village", why: "", lat: 47.15, lng: 8.75 }]), stay("Bregenz", 47.5, 9.75, 2)];
    const via = placeTrips([[47.37, 8.54], [47.05, 8.31], [47.5, 9.75], [47.37, 8.54]], stays, "mountains and lakes");
    expect(via.size).toBe(0);
    expect(stays.flatMap((s) => s.dayTrips || []).map((t) => t.place)).toEqual(["Lakeside village"]);
  });
  it("moves Vaduz off Lucerne (90 km) to Bregenz, the stay it's close to (43 km)", () => {
    const stays = [stay("Lucerne", 47.05, 8.31, 3, [{ place: "Vaduz", why: "", lat: 47.14, lng: 9.52 }]), stay("Bregenz", 47.5, 9.75, 2)];
    const via = placeTrips([[47.37, 8.54], [47.05, 8.31], [47.5, 9.75], [47.37, 8.54]], stays, "mountains and lakes");
    expect(via.size).toBe(0);
    expect(stays.map((s) => (s.dayTrips || []).map((t) => t.place))).toEqual([[], ["Vaduz"]]);
  });
});
describe("which day trips they named", () => {
  it("doesn't count the country they're staying in as naming a sight", () => {
    const stays = [{ ...stay("Hallstatt", 47.56, 13.65, 3), country: "Austria" }, { ...stay("Salzburg", 47.8, 13.04, 2), country: "Austria" }];
    stays[0].dayTrips = [{ place: "Hohenwerfen Castle, Werfen, Austria", why: "", lat: 47.68, lng: 13.345 } as any];
    const via = placeTrips([[48.1, 11.6], [47.56, 13.65], [47.8, 13.04], [48.1, 11.6]], stays, "take her to austria");
    expect(via.size).toBe(0);
  });
});
describe("far day trips that are on the way", () => {
  it("makes a far sight hardly off the drive a stop on the way, even if they didn't name it", () => {
    // Neuschwanstein as a day trip from Innsbruck (58 km in a straight line, 112 km by road), though it's on the drive from Innsbruck to the Allgäu.
    const stays = [stay("Innsbruck", 47.27, 11.39, 3, [{ place: "Neuschwanstein Castle", why: "", lat: 47.557, lng: 10.75 }]), stay("Lindau", 47.55, 9.68, 3)];
    const via = placeTrips([[48.1, 11.6], [47.27, 11.39], [47.55, 9.68], [48.1, 11.6]], stays, "impressive castles");
    expect(via.get(1)?.map((v) => v.place)).toEqual(["Neuschwanstein Castle"]);
  });
});
describe("day trips the map can't find", () => {
  it("stay on the stay the model put them on", () => {
    const stays = [stay("Reutte", 47.49, 10.72, 1), stay("Zell am See", 47.32, 12.8, 2, [{ place: "Grossglockner High Alpine Road", why: "" }])];
    placeTrips([[48.1, 11.6], [47.49, 10.72], [47.32, 12.8], [48.1, 11.6]], stays);
    expect(stays.map((s) => (s.dayTrips || []).map((t) => t.place))).toEqual([[], ["Grossglockner High Alpine Road"]]);
  });
});
