// On a split day only the stretches two groups share get the wider band underneath; the rest stays thin.
import { describe, expect, it } from "vitest";
import { cellsOf, sharedRuns } from "../web/src/map/shared-runs";

describe("shared stretches of split groups' lines", () => {
  it("finds where a line runs along another, even between far-apart vertices", () => {
    // B goes straight along the street (two vertices 1 km apart); A walks the middle of it, then turns off.
    const b = cellsOf([[[34.68, 135.50], [34.68, 135.51]]]);
    const a: [number, number][] = [[34.67, 135.503], [34.68, 135.503], [34.68, 135.504], [34.68, 135.505], [34.69, 135.505]];
    expect(sharedRuns(a, b)).toEqual([[[34.68, 135.503], [34.68, 135.504], [34.68, 135.505]]]);
  });
  it("leaves out overlaps too short to be a shared stretch", () => {
    const b = cellsOf([[[34.68, 135.50], [34.68, 135.51]]]);
    const a: [number, number][] = [[34.67, 135.503], [34.68, 135.503], [34.68, 135.505], [34.69, 135.505]]; // ~180 m along
    expect(sharedRuns(a, b, 0.1)).toHaveLength(1);
    expect(sharedRuns(a, b, 0.5)).toEqual([]);
  });
  it("finds nothing for lines across town from each other", () => {
    const b = cellsOf([[[34.70, 135.50], [34.70, 135.51]]]);
    expect(sharedRuns([[34.66, 135.50], [34.66, 135.51]], b)).toEqual([]);
  });
});
