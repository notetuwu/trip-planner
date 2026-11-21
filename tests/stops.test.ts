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
