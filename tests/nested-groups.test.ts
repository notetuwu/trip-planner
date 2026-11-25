// A split inside a split: four travel together, one stays at the hotel while three go for sushi, and the three then go
// three ways. The later groups ("Group B1"…) belong to the one they split off from ("Group B").
import { describe, expect, it } from "vitest";
import { groupOrder, lineGroup, onWay, parentGroup } from "../web/src/trip/split-tree";
import type { ItineraryItem } from "../shared/types";

const stop = (time: string, place: string, group?: string, people?: number): ItineraryItem => ({ time, place, description: "", ...(group ? { group, people } : {}) });
const who = (x: ItineraryItem) => x.group || "";
const onWayOf = (items: ItineraryItem[], y: ItineraryItem, g: string) => onWay(items, y, g, who);
const day = () => [
  stop("12:15", "Walk to hotel & check in"),
  stop("14:12", "Kura Sushi", "Group B", 3),
  stop("13:00", "Rest at the hotel", "Group A", 1),
  stop("17:12", "Akihabara", "Group B2", 1),
  stop("17:12", "Walking around", "Group B3", 1),
  stop("17:12", "Back to hotel", "Group B1", 1),
];

describe("a group that splits again", () => {
  it("knows the group it split off from, only when the day has it", () => {
    const labels = new Set(["Group A", "Group B", "Group B1"]);
    expect(parentGroup("Group B1", labels)).toBe("Group B");
    expect(parentGroup("Group B", labels)).toBe("");
    expect(parentGroup("Group 2", new Set(["Group 1", "Group 2"]))).toBe("");
    expect(parentGroup("Group C1", labels)).toBe("");
  });
  it("is shown and numbered after the group it split off from, the first group to set off first", () => {
    expect(groupOrder(day(), who)).toEqual(["Group A", "Group B", "Group B1", "Group B2", "Group B3"]);
  });
  it("carries on from that group's stops on the map, not from the hotel", () => {
    const items = day(), [hotel, sushi, rest, akiba] = items;
    expect(onWayOf(items, sushi, "Group B2")).toBe(true);
    expect(onWayOf(items, hotel, "Group B2")).toBe(true);
    expect(onWayOf(items, rest, "Group B2")).toBe(false);
    expect(onWayOf(items, akiba, "Group B")).toBe(false); // the three's own line ends at the sushi
    expect(lineGroup(items, "Group B", "Group B2", who)).toBe("Group B2"); // sushi → Akihabara is the Akihabara line
    expect(lineGroup(items, "Group B2", "", who)).toBe("Group B2");
  });
});
