import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { matchScore, namesFor } from "../server/geo/wiki-photos";
import { APP_DEFAULTS } from "../server/settings";
import { highlights, ownPhotos } from "../web/src/itinerary/preview-data";

const spot = { lat: 34.9671, lng: 135.7727 };
const article = (title: string, lat?: number, lng?: number) => ({ title, lat, lng, index: 1 });

describe("pictures from Wikimedia", () => {
  it("are off unless switched on", () => expect(APP_DEFAULTS.placePictures).toBe(false));

  it("takes an article with the place's name, where the stop is", () => {
    expect(matchScore("Fushimi Inari Taisha", "Kyoto", article("Fushimi Inari-taisha", 34.9672, 135.7725), spot)).toBe(3);
    expect(matchScore("Arashiyama Bamboo Grove", "Kyoto", article("Arashiyama", 34.9671, 135.7927), spot)).toBe(2);
    expect(matchScore("Sensō-ji", "Tokyo", article("Senso-ji", 34.967, 135.773), spot)).toBe(3);
  });

  it("takes nothing else that happens to be near", () => {
    expect(matchScore("Kyoto Station", "Kyoto", article("Kyoto", 34.9672, 135.7727), spot)).toBe(0);
    expect(matchScore("Kiyomizu Temple", "Kyoto", article("Tofuku Temple", 34.9672, 135.7727), spot)).toBe(0);
    // The same name far away is another place.
    expect(matchScore("Central Park", "Kyoto", article("Central Park", 40.78, -73.96), spot)).toBe(0);
    expect(matchScore("Fushimi walk", "Kyoto", article("Fushimi Castle"), spot)).toBe(0);
  });

  it("looks a stop up by its name, its first part and what's in brackets", () => {
    expect(namesFor("Visit Kinkaku-ji (Golden Pavilion)")).toEqual(["Kinkaku-ji", "Golden Pavilion"]);
    expect(namesFor("Gion & Hanamikoji Street")).toEqual(["Gion & Hanamikoji Street", "Gion"]);
  });
});

describe("asking Wikimedia", () => {
  it("gives a picture with its credit, and keeps an error from counting as no picture", async () => {
    vi.stubEnv("TRIP_PLANNER_DATA", fs.mkdtempSync(path.join(os.tmpdir(), "trip-pics-")));
    vi.resetModules();
    let broken = true;
    vi.stubGlobal("fetch", async (u: string) => Response.json(broken ? { error: { code: "maxlag" } }
      : u.includes("imageinfo")
        ? { query: { pages: [{ title: "File:Torii.jpg", imageinfo: [{ thumburl: "https://thumb.wikimedia.org/a/1280px-Torii.jpg?utm_source=x", descriptionurl: "https://commons.wikimedia.org/wiki/File:Torii.jpg", extmetadata: { Artist: { value: '<a href="#">A. Person</a>' }, LicenseShortName: { value: "CC BY-SA 4.0" } } }] }] } }
        : { query: { pages: [{ title: "Fushimi Inari-taisha", index: 1, pageimage: "Torii.jpg", coordinates: [{ lat: 34.9672, lon: 135.7727 }] }] } }));
    const { placePictures } = await import("../server/geo/wiki-photos");
    const ask = [{ id: "a", name: "Fushimi Inari Taisha", city: "Kyoto", cc: "xx", ...spot }];
    expect(await placePictures(ask)).toEqual({ pictures: {}, failed: 1 });
    broken = false;
    expect((await placePictures(ask)).pictures.a).toEqual({ url: "https://thumb.wikimedia.org/a/1280px-Torii.jpg", page: "https://commons.wikimedia.org/wiki/File:Torii.jpg", title: "Fushimi Inari-taisha", author: "A. Person", licence: "CC BY-SA 4.0" });
    // The quick round: the name as an article's title, following Wikipedia to the article's own.
    vi.stubGlobal("fetch", async (u: string) => Response.json(u.includes("imageinfo")
      ? { query: { pages: [{ title: "File:Torii.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/a/Torii.jpg" }] }] } }
      : { query: { redirects: [{ from: "Inari Shrine Fushimi", to: "Fushimi Inari-taisha" }], pages: [{ title: "Fushimi Inari-taisha", pageimage: "Torii.jpg", coordinates: [{ lat: 34.9672, lon: 135.7727 }] }, { title: "Nowhere", missing: true }] } }));
    const quick = await placePictures([{ ...ask[0], id: "b", name: "Inari Shrine Fushimi" }, { ...ask[0], id: "c", name: "Nowhere" }], true);
    expect(quick.failed).toBe(0);
    expect(quick.pictures.b?.url).toBe("https://upload.wikimedia.org/a/Torii.jpg");
    expect("c" in quick.pictures).toBe(false);
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
});

describe("the trip preview", () => {
  const days = [
    { date: "2027-04-01", stops: [{ key: "0-0", lat: 35, lng: 135 }, { key: "0-1", lat: 35.01, lng: 135 }] },
    { date: "2027-04-02", stops: [{ key: "1-0", lat: 36, lng: 136 }] },
  ];

  it("gives each of their photos to the stop it was taken at", () => {
    const at = { t: "2027-04-01T10:00:00", lat: 35.0101, lng: 135 };
    const away = { t: "2027-04-01T12:00:00", lat: 35.5, lng: 135 };
    const undated = { t: "", lat: 36.0001, lng: 136 };
    const otherYear = { t: "2020-04-01T10:00:00", lat: 35, lng: 135 };
    const own = ownPhotos([at, away, undated, otherYear], days);
    expect(own.byStop.get("0-1")).toEqual([at]);
    expect(own.byStop.get("1-0")).toEqual([undated]);
    expect(own.byStop.has("0-0")).toBe(false);
    expect(own.extra.get("2027-04-01")).toEqual([away]);
  });

  it("picks highlights from every town, must-sees first, no picture twice", () => {
    const all = [
      { town: "A", src: "1" }, { town: "A", src: "2", must: true }, { town: "A", src: "2" }, { town: "B", src: "3" }, { town: "A", src: "4" },
    ];
    expect(highlights(all, 3).map((x) => x.src)).toEqual(["2", "3", "1"]);
    expect(highlights(all, 9)).toHaveLength(4);
  });
});
