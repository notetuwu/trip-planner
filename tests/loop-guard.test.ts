import { describe, expect, it } from "vitest";
import { isLooping, loopGuard } from "../server/ai/loop-guard";

const normal = "Let me plan the research. The trip is in September. I need opening hours for the castles, ticket prices, "
  + "and events in Salzburg. Hohensalzburg is a fortress above the old town; I should check its hours. Then Hohenwerfen, "
  + "which is closed on Mondays. Padua next: the Scrovegni Chapel needs a timed ticket. Milan: the Duomo terraces. "
  + "Lucerne: Mount Pilatus and the Glacier Garden. Then the drive to the Allgäu with a stop at the Schattenburg. ";

describe("spotting a model that repeats itself", () => {
  it("doesn't flag normal thinking", () => {
    expect(isLooping(normal.repeat(1) + normal.slice(0, 300))).toBe(false);
  });
  it("flags the same sentence over and over", () => {
    expect(isLooping(normal + "Is Hohensalzburg a fortress? No. ".repeat(60))).toBe(true);
  });
  it("flags a repeated stretch without sentence breaks", () => {
    expect(isLooping(normal + "check the hours then check the hours then ".repeat(80))).toBe(true);
  });
  it("works on streamed pieces", () => {
    const feed = loopGuard();
    let hit = false;
    for (const w of (normal + "Is Hohensalzburg a fortress? No. ".repeat(80)).match(/.{1,7}/gs)!) hit ||= feed(w);
    expect(hit).toBe(true);
  });
});

describe("long rounds of the same checking", () => {
  // One round of "final checks" that a model went over again and again (about 1,200 characters).
  const round = `One last check on the castle marked on the way. If I go from the start to the lake town, the castle is on the way.
If I go from the lake town to the mountain town, the castle is not on the way. So it must be in the lake town's onTheWay list.
The small country is on the drive from the mountain town to the next town. So it must be in that stay's onTheWay list.
This is consistent. I will output the JSON. One detail: the castle is in one country and the lake town is in another.
Is it okay to have a stay in one country with an onTheWay place in another? Yes, because it's on the drive there.
I will use the exact names provided in the prompt for the place field in dayTrips and onTheWay, adding the country where
the prompt leaves it out, because the prompt says to use real place names that a map can find. This is correct.
Final check on the fortress: the prompt says the fortress gets a stay in its town. It does not ask for it to be in
dayTrips or onTheWay, so I don't need to list it in those fields. I will proceed.
`;
  it("spots a long block gone over three times", () => {
    expect(isLooping(round.repeat(2))).toBe(false); // going over it twice can be a real double-check
    expect(isLooping(round.repeat(3))).toBe(true);
  });
  it("lets a long, varied answer through", () => {
    const stays = Array.from({ length: 30 }, (_, k) => `{"city": "Town ${k}", "country": "Austria", "nights": ${1 + (k % 3)}, "why": "Lakes and a castle number ${k} to see"}`);
    expect(isLooping(`{"stays": [${stays.join(", ")}]}`)).toBe(false);
  });
});
