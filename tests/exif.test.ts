// The JPEG EXIF reader: time, GPS position, orientation and the embedded preview, from a block built by hand.
import { describe, expect, it } from "vitest";
import { readExif, turnFor } from "../server/geo/exif";
import { jpeg } from "./helpers/jpeg";

describe("readExif", () => {
  it("reads the time, the position, the orientation and the preview", () => {
    const x = readExif(jpeg());
    expect(x.t).toBe("2027-09-10T09:41:03");
    expect(x.lat).toBeCloseTo(47.0502, 4);
    expect(x.lng).toBeCloseTo(8.3093, 4);
    expect(x.orientation).toBe(6);
    expect([...x.thumb!]).toEqual([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
  });

  it("makes south and west negative", () => {
    const x = readExif(jpeg({ south: true, west: true }));
    expect(x.lat).toBeCloseTo(-47.0502, 4);
    expect(x.lng).toBeCloseTo(-8.3093, 4);
  });

  it("returns what it can for a picture with no position, and nothing for a file that isn't a JPEG", () => {
    const x = readExif(jpeg({ withGps: false }));
    expect(x.t).toBe("2027-09-10T09:41:03");
    expect(x.lat).toBeUndefined();
    expect(readExif(Buffer.from("not a picture at all"))).toEqual({});
    expect(readExif(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda]))).toEqual({});
  });

  it("says how far to turn a stored picture to see it upright", () => {
    expect([1, 6, 3, 8, undefined].map(turnFor)).toEqual([0, 90, 180, 270, 0]);
  });
});
