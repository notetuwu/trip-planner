// Where a photo with no GPS probably was taken, from the plan: its day and the stop they were at that time.
import { describe, expect, it } from "vitest";
import { anchorsOf, spotByTime } from "../web/src/map/photo-spot";

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

  it("puts a photo shortly before a stop at that stop, and one far from both at the nearer of the two (never on a line between them)", () => {
    expect(spotByTime("2027-09-14T14:30:00", [day])?.near).toBe("Castelvecchio");
    expect(spotByTime("2027-09-14T11:00:00", [day])).toEqual({ lat: 45.45, lng: 10.99, near: "Arena" });
    expect(spotByTime("2027-09-14T11:50:00", [day])).toEqual({ lat: 45.46, lng: 11, near: "Lunch" });
  });

  it("goes by their own photos with a position taken around then, before the plan (they may not have followed it)", () => {
    const anchors = anchorsOf([
      { t: "2027-09-14T09:40:00", lat: 35.0142, lng: 135.7482 }, // Nijō Castle, Kyoto, though the plan says Verona
      { t: "2027-09-14T12:00:00" },
      { t: "2027-09-14T16:00:00", lat: 34.6873, lng: 135.5262 },
    ]);
    expect(spotByTime("2027-09-14T10:10:00", [day], anchors)).toMatchObject({ lat: 35.0142, lng: 135.7482, near: "where you took a photo 30 min before" });
    expect(spotByTime("2027-09-14T15:40:00", [day], anchors)).toMatchObject({ lat: 34.6873, near: "where you took a photo 20 min after" });
    // Nothing with a position within 45 minutes: the plan.
    expect(spotByTime("2027-09-14T13:10:00", [day], anchors)?.near).toBe("Lunch");
    // A day the plan doesn't have is still placed by photos.
    expect(spotByTime("2027-09-14T09:45:00", [], anchors)?.lat).toBe(35.0142);
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
