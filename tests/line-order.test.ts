import { describe, expect, it } from "vitest";
import { joinPieces, orderStops } from "../shared/line-order";

describe("a line's stops from the downloaded areas", () => {
  // A line running east along 47.00 N, cut into areas, its pieces out of order and one the other way round.
  const a: [number, number][] = [[47, 8.30], [47, 8.31], [47, 8.32]];
  const b: [number, number][] = [[47, 8.35], [47, 8.34], [47, 8.33], [47, 8.32]];
  const c: [number, number][] = [[47, 8.35], [47, 8.36], [47, 8.37]];
  const back: [number, number][] = [[47.0002, 8.34], [47.0002, 8.33]];

  it("joins the pieces into one path, leaving out the other direction", () => {
    const path = joinPieces([c, back, a, b]);
    expect(path[0][1] === 8.3 || path.at(-1)![1] === 8.3).toBe(true);
    expect(path.filter((p) => p[0] !== 47)).toEqual([]);
  });

  it("puts the stops in order along it", () => {
    const stop = (name: string, lng: number) => ({ name, lat: 47.0003, lng });
    const got = orderStops([stop("C", 8.365), stop("A", 8.305), stop("Far", 9.5), stop("B", 8.335)], [c, back, a, b]).map((s) => s.name);
    expect([got.slice(0, 3).join(""), got.slice(0, 3).reverse().join("")]).toContain("ABC");
    expect(got[3]).toBe("Far");
  });
});
