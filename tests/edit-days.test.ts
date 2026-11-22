// A change from the trip chat: only the days it touches go to the model (the rest as names, to keep as is), with the
// rule to change nothing the request doesn't ask for, and only those days come back.
import { describe, expect, it } from "vitest";
import { editSection } from "../server/ai/prompt";

const day = (date: string, city: string, places: string[]) => ({ date, city, title: city, estimatedCost: 0, items: places.map((place) => ({ time: "10:00", place, description: "" })) });
const itinerary = { summary: "", totalEstimatedCost: 0, days: [day("2027-09-14", "Kyoto", ["Fushimi Inari"]), day("2027-09-15", "Kyoto", ["Kinkaku-ji"]), day("2027-09-16", "Nara", ["Nara Park"])] };

describe("changing some days", () => {
  it("sends only those days in full, the others to keep, and the rule", () => {
    const p = editSection({ itinerary, days: [2, 1], request: "Swap days 2 and 3" });
    expect(p).toContain('"place":"Kinkaku-ji"');
    expect(p).toContain('"place":"Nara Park"');
    expect(p).not.toContain('"place":"Fushimi Inari"');
    expect(p).toContain("2027-09-14 Kyoto: Fushimi Inari");
    expect(p).toContain("Swap days 2 and 3");
    expect(p).toContain("Make exactly this change and nothing else");
    expect(p).toContain("Keep day trips, travel between stays, where they sleep and anything booked");
    expect(p).toContain('"days" containing only these 2 day(s) (2027-09-15, 2027-09-16)');
  });
});
