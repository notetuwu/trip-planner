// Hovering a stop lights only its own way: a split day lists the groups one after another.
import { describe, expect, it } from "vitest";
import { legStops as stopsOf } from "../web/src/trip/split-tree";

interface Stop { group: string; transfer: boolean }
const stop = (group: string, transfer = false): Stop => ({ group, transfer });
const legStops = (items: Stop[], leg: { fromXi: number; xi: number; group: string }) => stopsOf(items, leg, (x) => x.group, (x) => x.transfer);

describe("the stops a leg lights up for", () => {
  // Everyone, then A, then B, which splits into B1, B2 and B3.
  const items = [stop(""), stop("Group A"), stop("Group B"), stop("Group B1"), stop("Group B2"), stop("Group B3")];

  it("leaves out the other groups listed in between", () => {
    expect(legStops(items, { fromXi: 0, xi: 2, group: "Group B" })).toEqual([2]);
    expect(legStops(items, { fromXi: 2, xi: 3, group: "Group B1" })).toEqual([3]);
    expect(legStops(items, { fromXi: 2, xi: 5, group: "Group B3" })).toEqual([5]);
  });

  it("keeps the group's own transfers on the way", () => {
    const way = [stop("Group A"), stop("Group A", true), stop("Group A")];
    expect(legStops(way, { fromXi: 0, xi: 2, group: "Group A" })).toEqual([1, 2]);
  });
});
