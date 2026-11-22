// Sunrise and sunset for the prompt, in the stay's local time.
import { describe, expect, it } from "vitest";
import { localTime, sunUtc } from "../server/trip/daylight";

const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

describe("daylight", () => {
  it("matches published times within a few minutes", () => {
    const osaka = sunUtc(34.69, 135.50, "2026-11-05")!; // about 06:20 and 17:03 JST
    expect(Math.abs(mins(localTime("2026-11-05", osaka.rise, "Asia/Tokyo")) - mins("06:20"))).toBeLessThanOrEqual(4);
    expect(Math.abs(mins(localTime("2026-11-05", osaka.set, "Asia/Tokyo")) - mins("17:03"))).toBeLessThanOrEqual(4);
    const vienna = sunUtc(48.21, 16.37, "2026-07-01")!; // about 04:56 and 20:58 CEST (summer time)
    expect(Math.abs(mins(localTime("2026-07-01", vienna.set, "Europe/Vienna")) - mins("20:58"))).toBeLessThanOrEqual(4);
  });
  it("has no sunset in the polar summer", () => {
    expect(sunUtc(78.2, 15.6, "2026-06-21")).toBeNull();
  });
});
