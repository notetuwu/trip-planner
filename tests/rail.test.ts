import { describe, expect, it } from "vitest";
import { decodePolyline } from "../server/geo/routing";

describe("train lines from the public transport router", () => {
  it("decodes an encoded polyline", () => {
    // The example from Google's polyline format documentation (5 decimal places).
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5)).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });
  it("decodes with 6 decimal places, as Transitous sends", () => {
    const pts: [number, number][] = [[48.140232, 11.558335], [47.812803, 13.045621], [47.8, 13.04]];
    expect(decodePolyline(encode(pts, 6), 6)).toEqual(pts);
  });
});

/** The polyline format's encoder, to check the decoder against any points. */
function encode(pts: [number, number][], precision: number) {
  const f = 10 ** precision;
  let out = "", plat = 0, plng = 0;
  const one = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lng] of pts) {
    const a = Math.round(lat * f), b = Math.round(lng * f);
    one(a - plat); one(b - plng); plat = a; plng = b;
  }
  return out;
}

import { bestHit } from "../server/geo/geocode";
describe("choosing among place search answers", () => {
  it("takes the village over the middle of its municipality", () => {
    const hits = [
      { category: "boundary", type: "administrative", name: "Hallstatt", lat: "47.5348", lon: "13.5989" },
      { category: "place", type: "village", name: "Hallstatt", lat: "47.5622", lon: "13.6487" },
    ];
    expect(bestHit(hits)?.type).toBe("village");
  });
  it("keeps the first answer otherwise", () => {
    const hits = [{ category: "place", type: "city", name: "Lucerne" }, { category: "boundary", type: "administrative", name: "Lucerne" }];
    expect(bestHit(hits)?.type).toBe("city");
    expect(bestHit([{ category: "boundary", type: "administrative", name: "Bezirk X" }])?.type).toBe("administrative");
  });
  it("takes the town over a province that only has its name among others (Bolzano, not South Tyrol by Merano)", () => {
    const hits = [
      { category: "boundary", type: "administrative", place_rank: 12, name: "South Tyrol" },
      { category: "boundary", type: "administrative", place_rank: 16, name: "Bolzano" },
      { category: "place", type: "village", place_rank: 19, name: "Bolzano Bellunese" },
    ];
    expect(bestHit(hits, "Bolzano, Italy")?.name).toBe("Bolzano");
    expect(bestHit([{ ...hits[1], name: "Bolzano - Bozen" }, hits[2]], "Bozen")?.name).toBe("Bolzano - Bozen");
    // A region asked for by its own name stays the region.
    expect(bestHit([{ category: "boundary", place_rank: 8, name: "Tyrol" }, { category: "place", place_rank: 19, name: "Tirolo" }], "Tyrol")?.place_rank).toBe(8);
  });
});

import { countryCode } from "../server/geo/geocode";
describe("country names in place searches", () => {
  it("knows a country's code from its English name, and nothing else", () => {
    expect(countryCode("Austria")).toBe("at");
    expect(countryCode(" switzerland ")).toBe("ch");
    expect(countryCode("Upper Austria")).toBe("");
    expect(countryCode("Salzburg")).toBe("");
  });
});
