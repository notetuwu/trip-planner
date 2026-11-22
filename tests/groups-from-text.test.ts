// A split written only into the stops' text still splits the day.
import { describe, expect, it } from "vitest";
import { groupsFromText } from "../shared/groups";

describe("groups from the text", () => {
  it("reads 'Group A (2 people):' labels and drops them from the text", () => {
    const days = [{ items: [
      { place: "Hotel breakfast", description: "Both groups meet at the lobby." },
      { place: "Osaka → Onomichi (JR limited express)", description: "Group A (2 people): JR limited express via Okayama." },
      { place: "Shin-Osaka → Hiroshima", description: "Group B (2 people): Hikari Shinkansen." },
      { place: "Kotohira-gu", description: "Group A: Walk the first 100 steps." },
      { place: "Peace Memorial Park", description: "GROUP B. The park is free." },
      { place: "Dinner", description: "All 4 meet back in Osaka." },
    ] }] as any[];
    expect(groupsFromText(days)).toBe(true);
    expect(days[0].items.map((x: any) => x.group || "")).toEqual(["", "Group A", "Group B", "Group A", "Group B", ""]);
    expect(days[0].items[3]).toMatchObject({ people: 2, description: "Walk the first 100 steps." });
    expect(days[0].items[4].description).toBe("The park is free.");
  });
  it("leaves days alone that use the field, or mention only one group", () => {
    const used = [{ items: [{ place: "A", description: "Group B: x", group: "Group A" }] }] as any[];
    const one = [{ items: [{ place: "A", description: "Group A: the only one" }] }] as any[];
    expect(groupsFromText(used)).toBe(false);
    expect(groupsFromText(one)).toBe(false);
  });
});
