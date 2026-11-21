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
  it("makes a sight between two stays a stop on that travel day", () => {
    // Vaduz on a day trip from Lucerne, though it lies on the drive from Lucerne to Bregenz.
    const stays = [stay("Lucerne", 47.05, 8.31, 3, [{ place: "Vaduz", why: "Liechtenstein", lat: 47.14, lng: 9.52 }]), stay("Bregenz", 47.5, 9.75, 2)];
    const via = placeTrips([[47.37, 8.54], [47.05, 8.31], [47.5, 9.75], [47.37, 8.54]], stays);
    expect(stays[0].dayTrips).toEqual([]);
    expect(via.get(1)?.map((v) => v.place)).toEqual(["Vaduz"]);
  });
});
