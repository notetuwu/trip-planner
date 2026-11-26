// The gallery's stays: a photo belongs to the stay slept at that night, the trip's last day to the last stay.
import { describe, expect, it } from "vitest";
import { stayIndexOn } from "../web/src/itinerary/photo-stays";

describe("stayIndexOn", () => {
  const stays = [{ start: "2027-09-10", nights: 2 }, { start: "2027-09-12", nights: 3 }];

  it("gives the stay of that night, and a travel day to the stay arrived at", () => {
    expect(["2027-09-10", "2027-09-11", "2027-09-12", "2027-09-14"].map((d) => stayIndexOn(d, stays))).toEqual([0, 0, 1, 1]);
  });

  it("counts the day of leaving to the last stay, and nothing outside the trip", () => {
    expect(stayIndexOn("2027-09-15", stays)).toBe(1);
    expect(["2027-09-09", "2027-09-16", ""].map((d) => stayIndexOn(d, stays))).toEqual([-1, -1, -1]);
    expect(stayIndexOn("2027-09-10", [{ nights: 2 }])).toBe(-1);
  });
});
