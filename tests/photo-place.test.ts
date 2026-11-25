import { describe, expect, it } from "vitest";
import { burstsOf, spotKey, withSpot } from "../web/src/map/photo-spot";
import { merge3 } from "../shared/merge";

describe("photos placed by hand", () => {
  it("override the camera's position, or take it away", () => {
    const gps = { lat: 1, lng: 2 };
    expect(withSpot(gps, undefined)).toMatchObject({ lat: 1, lng: 2, camera: true });
    expect(withSpot(gps, { lat: 3, lng: 4 })).toMatchObject({ lat: 3, lng: 4, camera: true, placed: true });
    expect(withSpot(gps, { skip: true })).toMatchObject({ lat: undefined, skipped: true });
    expect(withSpot({} as { lat?: number; lng?: number }, { lat: 3, lng: 4 })).toMatchObject({ camera: false, placed: true });
  });
  it("ignore a spot that isn't a position", () => {
    expect(withSpot({} as { lat?: number; lng?: number }, { lat: 999, lng: 4 }).placed).toBeUndefined();
    expect(withSpot({} as { lat?: number; lng?: number }, { lat: "1", lng: 4 } as any).placed).toBeUndefined();
  });
  it("are kept under a name that works on another computer", () => {
    expect(spotKey("https://drive.google.com/drive/folders/abc", "FILE1")).toBe("FILE1");
    expect(spotKey("local:C:\\Users\\a\\Japan\\", "day1/IMG_1.jpg")).toBe(spotKey("local:/home/b/Japan", "day1/IMG_1.jpg"));
    expect(spotKey("local:D:\\Mine", "IMG_1.jpg")).not.toBe(spotKey("local:D:\\Theirs", "IMG_1.jpg"));
  });
  it("from two people are joined", () => {
    const m = merge3({ notes: "" }, { notes: "", photoSpots: { a: { lat: 1, lng: 1 } } }, { notes: "", photoSpots: { b: { skip: true } } });
    expect(m.clashes).toEqual([]);
    expect(m.value).toMatchObject({ photoSpots: { a: { lat: 1, lng: 1 }, b: { skip: true } } });
  });
});

describe("groups of photos taken together", () => {
  const at = (t: string) => ({ t });
  it("start after a pause or on another day; those without a time come last", () => {
    const g = burstsOf([at(""), at("2027-09-10T10:20:00"), at("2027-09-10T10:00:00"), at("2027-09-10T10:08:00"), at("2027-09-11T10:09:00")]);
    expect(g.map((x) => x.length)).toEqual([2, 1, 1, 1]);
    expect(g[0][0].t).toBe("2027-09-10T10:00:00");
    expect(g[3][0].t).toBe("");
  });
});
