// Several place lists: merged (a place on two lists counts once), and only places the trip can reach go to the model.
import { describe, expect, it } from "vitest";
import { mergeListPlaces } from "../server/routes/itinerary";

const p = (title: string, lat?: number, lng?: number) => ({ title, ...(lat != null ? { lat, lng } : {}) });

describe("merging place lists", () => {
  const japan = [p("Fushimi Inari", 34.967, 135.773), p("Dotonbori", 34.669, 135.501)];
  const alps = [p("Hohenwerfen Castle", 47.482, 13.188), p("Hallstatt", 47.562, 13.649), p("fushimi inari"), p("Somewhere unknown")];
  const salzburg = [{ lat: 47.8095, lng: 13.055 }];

  it("keeps places near the stays, drops far ones, counts duplicates once", () => {
    const got = mergeListPlaces([japan, alps], salzburg).map((x) => x.title);
    expect(got).toEqual(["Hohenwerfen Castle", "Hallstatt", "Somewhere unknown"]);
  });
  it("keeps far must-sees, and everything when the stays aren't located yet", () => {
    expect(mergeListPlaces([japan, alps], salzburg, ["Dotonbori"]).map((x) => x.title)).toContain("Dotonbori");
    expect(mergeListPlaces([japan, alps], [{}])).toHaveLength(5);
  });
});
