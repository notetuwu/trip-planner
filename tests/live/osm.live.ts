// What the planner is given for one town, from the real OpenStreetMap servers: the sights and food as ranked, and the
// places of the kinds asked for. Not part of `npm test`. Run with `npm run test:live -- osm` and:
//   TOWN    the town ("Budapest, Hungary")
//   KINDS   kinds to look for, comma-separated (see WANT_KINDS in server/trip/prefs.ts), optional
//   MIX     popular | mixed | hidden (default mixed)
//   DIET    diets, comma-separated (vegetarian, vegan, gluten_free…), optional
import { describe, expect, it } from "vitest";
import { rankNearby, rankWished } from "../../server/trip/nearby";
import { nearbyElements, wishedElements } from "../../server/trip/overpass";
import { type Diet, type Prefs, type WantKind } from "../../server/trip/prefs";

const TOWN = process.env.TOWN || "";

describe.skipIf(!TOWN)("OpenStreetMap lists, live", () => {
  it("fetches and ranks one town's lists", async () => {
    const kinds = (process.env.KINDS || "").split(",").map((s) => s.trim()).filter(Boolean) as WantKind[];
    const prefs: Prefs = { diet: (process.env.DIET || "").split(",").map((s) => s.trim()).filter(Boolean) as Diet[], allergies: [], avoid: [], wants: kinds.map((k) => ({ kind: k, what: k })), placeMix: (process.env.MIX as Prefs["placeMix"]) || "mixed" };
    let t = Date.now();
    const elements = await nearbyElements(TOWN, undefined, (s) => console.log(s));
    console.log(`${elements?.length ?? 0} elements in ${((Date.now() - t) / 1000).toFixed(0)} s`);
    expect(elements?.length).toBeGreaterThan(0);
    const { sights, food } = rankNearby(elements!, prefs);
    console.log("SIGHTS\n" + sights.map((p) => `  ${p.name} (${p.kind}${p.extras.length ? `; ${p.extras.join(", ")}` : ""})`).join("\n"));
    console.log("FOOD\n" + food.slice(0, 15).map((p) => `  ${p.name} (${p.kind}${p.extras.length ? `; ${p.extras.join(", ")}` : ""})`).join("\n"));
    if (kinds.length) {
      t = Date.now();
      const wished = await wishedElements(TOWN, undefined, kinds, (s) => console.log(s));
      console.log(`${wished?.length ?? 0} wished elements in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      console.log("WISHED\n" + rankWished(wished || [], prefs.wants, prefs).map((p) => `  ${p.name} (${p.kind}) for ${p.for}`).join("\n"));
    }
  }, 15 * 60_000);
});
