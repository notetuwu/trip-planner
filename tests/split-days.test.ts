// Dates in the prompt carry their weekday, day trips part of the group takes become split days, and must-sees the
// plan leaves out without a word show up under "Didn't fit".
import { describe, expect, it } from "vitest";
import { stayLines, tripLine, withDay } from "../server/ai/prompt-sections";
import { addMissingMustSees } from "../server/ai/output";

const trip: any = {
  travelers: 4,
  stays: [{ city: "Osaka", start: "2026-11-02", nights: 6, hotel: "", dayTrips: [
    { place: "Onomichi", mode: "train", people: 2 },
    { place: "Himeji", mode: "train" },
  ] }],
};

describe("the prompt's stays", () => {
  it("gives every date its weekday", () => {
    expect(withDay("2026-11-02")).toBe("2026-11-02 (Mon)");
    expect(withDay("2026-11-10")).toBe("2026-11-10 (Tue)");
    const text = stayLines(trip);
    expect(text).toContain("arrive 2026-11-02 (Mon)");
    expect(text).toContain("2026-11-08 (Sun) departure");
    expect(text).toContain("full days: 2026-11-03 (Tue), 2026-11-04 (Wed)");
  });
  it("says when only part of the group goes on a day trip", () => {
    const text = stayLines(trip);
    expect(text).toMatch(/Onomichi[^\n]*only 2 of the 4 travelers go/);
    expect(text).not.toMatch(/Himeji[^\n]*only/);
    expect(tripLine(trip)).toContain("day trip to Onomichi by train (only 2 of the 4 travelers go)");
  });
});

describe("must-sees left out", () => {
  it("are listed with a reason unless a stop shares most of their words", () => {
    const it2: any = { days: [{ items: [{ place: "ZEN Chopsticks Workshop" }, { place: "Nara Park" }] }], unused: [{ place: "Universal Studios Japan", reason: "no time" }] };
    addMissingMustSees(it2, ["ZEN Chopsticks Making Workshop Gion Kyoto", "Nara Park", "teamLab Borderless", "Universal Studios Japan"]);
    expect(it2.unused.map((u: any) => u.place)).toEqual(["Universal Studios Japan", "teamLab Borderless"]);
    expect(it2.unused[1].reason).toMatch(/didn't say why/);
  });
});
