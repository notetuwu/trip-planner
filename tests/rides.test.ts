import { describe, expect, it } from "vitest";
import type { Ride } from "../shared/geo";
import { compareRides, kindsAgree, linesNamed, rideLine, ridesText } from "../shared/rides";
import { ridesOf } from "../server/geo/routing";
import { utcOf } from "../server/trip/daylight";
import { walksOf } from "../web/src/map/walks";

const stop = (n: string) => ({ n, lat: 47, lng: 8 });
const bus5: Ride = { mode: "BUS", line: "5", to: "Kriens, Busschleife", on: stop("Luzern, Moosegg"), off: stop("Kriens, Busschleife"), stops: [stop("Eichhof"), stop("Kupferhammer")] };
const chuo: Ride = { mode: "REGIONAL_RAIL", line: "JC", name: "JR中央線快速 JR Chūō Rapid Line", colour: "#ff5c1e", to: "Tōkyō", on: stop("新宿 Shinjuku"), off: stop("東京 Tōkyō"), stops: [] };
const osaka: Ride = { mode: "REGIONAL_RAIL", colour: "#019a66", agency: "Osaka Metro", to: "学研奈良登美ヶ丘", on: stop("本町"), off: stop("森ノ宮"), stops: [stop("堺筋本町"), stop("谷町四丁目")] };

describe("the rides of a leg against the plan", () => {
  it("reads the line numbers the plan names", () => {
    expect(linesNamed("Take bus 8 to the station, then tram no. 2")).toEqual(["8", "2"]);
    expect(linesNamed("U2 to Alexanderplatz, S-Bahn S41")).toEqual(expect.arrayContaining(["u2", "s41"]));
    expect(linesNamed("Walk 10 min")).toEqual([]);
  });

  it("keeps the plan's words when they name the timetable's line", () => {
    expect(compareRides("Bus 5 to Kriens (15 min)", [bus5])).toBe("same");
    expect(compareRides("JR Chuo Line to Tokyo", [chuo])).toBe("same");
    expect(compareRides("JC line, 15 min", [chuo])).toBe("same");
  });

  it("notices another line, or none", () => {
    expect(compareRides("Bus 8 to Kriens", [bus5])).toBe("other");
    expect(compareRides("Take the bus, 20 min", [bus5])).toBe("none");
  });

  it("leaves the plan alone when the timetable gives no line to compare (Osaka Metro)", () => {
    expect(compareRides("Chuo Line to Morinomiya", [osaka])).toBe("same");
  });

  it("changes the plan only for the kind of vehicle it names", () => {
    expect(kindsAgree("Take bus 8", [bus5])).toBe(true);
    expect(kindsAgree("Tram 2 to the lake", [bus5])).toBe(false);
    expect(kindsAgree("Metro to Morinomiya", [osaka], "transit")).toBe(true);
    expect(kindsAgree("20 min", [bus5])).toBe(true);
  });

  it("says the rides in words", () => {
    expect(rideLine(bus5)).toBe("Bus 5 towards Kriens, Busschleife: Luzern, Moosegg → Kriens, Busschleife, 3 stops");
    expect(ridesText([bus5, chuo], "transit")).toBe("Bus 5 towards Kriens, Busschleife, then Train JC (JR中央線快速 JR Chūō Rapid Line) towards Tōkyō");
    expect(rideLine(osaka)).toBe("Metro (Osaka Metro) towards 学研奈良登美ヶ丘: 本町 → 森ノ宮, 3 stops");
  });
});

describe("a leg's walks", () => {
  it("are the parts of its line that aren't a ride", () => {
    const line: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7]];
    // Walk 0–1, bus 1–3, walk 3–4, bus 4–6, walk 6–7.
    expect(walksOf(line, [[[0, 1], [0, 2], [0, 3]], [[0, 4], [0, 5], [0, 6]]])).toEqual([[[0, 0], [0, 1]], [[0, 3], [0, 4]], [[0, 6], [0, 7]]]);
    expect(walksOf(line, [line])).toEqual([]);
  });
});

describe("rides from Transitous", () => {
  it("keeps the line, its colour, the stops and the local departure; not an internal number as a line", () => {
    const leg = (o: object) => ({ mode: "BUS", headsign: "Kriens", from: { name: "A", lat: 47.1, lon: 8.1, departure: "2026-11-25T07:25:00Z", tz: "Europe/Zurich" }, to: { name: "B", lat: 47.2, lon: 8.2 }, intermediateStops: [{ name: "C", lat: 47.15, lon: 8.15 }], ...o });
    const [a, b] = ridesOf([{ mode: "WALK" }, leg({ routeShortName: "5", routeColor: "E30613" }), leg({ routeShortName: "9832171", agencyName: "Osaka Metro" })]);
    expect(a).toMatchObject({ line: "5", colour: "#e30613", to: "Kriens", dep: "08:25", stops: [{ n: "C" }] });
    expect(b.line).toBeUndefined();
    expect(b.agency).toBe("Osaka Metro");
  });

  it("asks for the plan's local time as the moment it is", () => {
    expect(utcOf("2027-04-03T09:00", "Asia/Tokyo")).toBe("2027-04-03T00:00:00Z");
    expect(utcOf("2027-07-10T08:15", "Europe/Zurich")).toBe("2027-07-10T06:15:00Z");
    expect(utcOf("2027-01-10T08:15", "Europe/Zurich")).toBe("2027-01-10T07:15:00Z");
  });
});
