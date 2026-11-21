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
