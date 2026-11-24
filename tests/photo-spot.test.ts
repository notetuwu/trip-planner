// Where a photo with no GPS probably was taken, from the plan: its day and the stop they were at that time.
import { describe, expect, it } from "vitest";
import { spotByTime } from "../web/src/map/photo-spot";

const day = { date: "2027-09-14", home: { lat: 45.44, lng: 10.99, name: "Hotel" }, stops: [
  { min: 9 * 60 + 30, lat: 45.45, lng: 10.99, name: "Arena" },
  { min: 13 * 60, lat: 45.46, lng: 11.0, name: "Lunch" },
  { min: 15 * 60, lat: 45.47, lng: 11.02, name: "Castelvecchio" },
] };

describe("spotByTime", () => {
  it("puts a photo at the stop it was taken during, or just after", () => {
    expect(spotByTime("2027-09-14T09:50:00", [day])).toEqual({ lat: 45.45, lng: 10.99, near: "Arena" });
    expect(spotByTime("2027-09-14T13:25:00", [day])).toEqual({ lat: 45.46, lng: 11, near: "Lunch" });
  });

  it("puts a photo shortly before a stop at that stop, and one far from both on the way between them", () => {
    expect(spotByTime("2027-09-14T14:30:00", [day])?.near).toBe("Castelvecchio");
    const way = spotByTime("2027-09-14T11:15:00", [day])!;
    expect(way.near).toBe("Arena → Lunch");
    expect(way.lat).toBeCloseTo(45.45 + 0.01 * 0.5, 6);
  });

  it("uses the hotel before the day starts and long after the last stop, and null for a day that isn't in the plan", () => {
    expect(spotByTime("2027-09-14T06:00:00", [day])?.near).toBe("Hotel");
    expect(spotByTime("2027-09-14T22:00:00", [day])?.near).toBe("Hotel");
    expect(spotByTime("2027-10-01T12:00:00", [day])).toBeNull();
    expect(spotByTime("", [day])).toBeNull();
  });

  it("falls back to the hotel for a day with no timed stops", () => {
    expect(spotByTime("2027-09-15T12:00:00", [{ date: "2027-09-15", stops: [], home: day.home }])?.near).toBe("Hotel");
    expect(spotByTime("2027-09-15T12:00:00", [{ date: "2027-09-15", stops: [] }])).toBeNull();
  });
});
