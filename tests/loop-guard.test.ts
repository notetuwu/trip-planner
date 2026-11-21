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
