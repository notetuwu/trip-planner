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
