// The map's transport line overlays: Overpass's answer for a cell (each route's tags, then the ids of its ways and stops
// in the cell, then every way once with its shape, then the stops) becomes one line per line and direction pair,
// sharing the shapes, with the stops and the lines calling there.
import { describe, expect, it } from "vitest";
import { toCell } from "../server/geo/transit-lines";

let next = 1000;
const rel = (tags: Record<string, string>, id = next++) => ({ type: "relation", id, tags });
const ids = (...ws: number[]) => ws.map((id) => ({ type: "way", id }));
const stopIds = (...ns: number[]) => ns.map((id) => ({ type: "node", id }));
const way = (id: number, pts: ([number, number] | null)[], tags?: Record<string, string>) =>
  ({ type: "way", id, ...(tags ? { tags } : {}), geometry: pts.map((p) => (p ? { lat: p[0], lon: p[1] } : null)) });
const stop = (id: number, lat: number, lon: number, name: string) => ({ type: "node", id, lat, lon, tags: { name } });
/** The lines without their route ids (checked on their own where it matters). */
const lines = (cell: ReturnType<typeof toCell>) => cell.l.map(({ r: _r, ...x }) => x);

describe("toCell", () => {
  it("merges a line's two directions, drops long-distance coaches, and keeps each shape once", () => {
    const cell = toCell([
      rel({ type: "route", route: "bus", ref: "5", name: "Bus 5: Kriens => Luzern", colour: "#E30613" }, 51), ...ids(1, 2),
      rel({ type: "route", route: "bus", ref: "5", name: "Bus 5: Luzern => Kriens", colour: "#E30613" }, 52), ...ids(2, 3),
      rel({ type: "route", route: "bus", ref: "421", name: "Flixbus 421: Zürich => Pescara" }), ...ids(1),
      rel({ type: "route", route: "subway", ref: "M2" }), ...ids(9),
      way(1, [[47.05, 8.30], [47.051, 8.301]]), way(2, [[47.051, 8.301], [47.052, 8.302]]), way(3, [[47.052, 8.302], [47.053, 8.303]]),
    ]);
    expect(lines(cell)).toEqual([{ k: "bus", n: "5 · Kriens => Luzern", c: "#E30613", w: [1, 2, 3] }]);
    expect(cell.l[0].r).toEqual([51, 52]);
    expect(Object.keys(cell.w).sort()).toEqual(["1", "2", "3"]);
  });

  it("splits a shape where it leaves the cell, and lists a lift that's in no route as a line of its own", () => {
    const cell = toCell([way(7, [[46.99, 8.30], [47.0, 8.31], null, [47.01, 8.33], [47.02, 8.34]], { aerialway: "gondola", name: "Kriens–Fräkmüntegg" })]);
    expect(lines(cell)).toEqual([{ k: "lift", n: "Kriens–Fräkmüntegg", w: [7] }]);
    expect(cell.w[7]).toEqual([[[46.99, 8.3], [47, 8.31]], [[47.01, 8.33], [47.02, 8.34]]]);
  });

  it("takes a line's colour from its route master when the route has none", () => {
    const cell = toCell([
      rel({ type: "route", route: "bus", ref: "1", name: "Bus 1: Kriens => Ebikon" }), rel({ type: "route_master", route_master: "bus", ref: "1", colour: "#0067b1" }), ...ids(1),
      rel({ type: "route", route: "bus", ref: "1", name: "Bus 1: Ebikon => Kriens" }), rel({ type: "route_master", route_master: "bus", ref: "1", colour: "#0067b1" }), ...ids(2),
      way(1, [[47.05, 8.30], [47.051, 8.301]]), way(2, [[47.051, 8.301], [47.052, 8.302]]),
    ]);
    expect(lines(cell)).toEqual([{ k: "bus", n: "1 · Kriens => Ebikon", c: "#0067b1", w: [1, 2] }]);
  });

  it("matches a route master's colour to its routes by id, when the masters come first", () => {
    const cell = toCell([
      { type: "relation", id: 900, tags: { type: "route_master", ref: "2", colour: "#8dc63f" }, members: [{ type: "relation", ref: 101 }, { type: "relation", ref: 102 }] },
      rel({ type: "route", route: "bus", ref: "2", name: "Bus 2: Horw => Luzern" }, 101), ...ids(1),
      rel({ type: "route", route: "bus", ref: "2", name: "Bus 2: Luzern => Horw" }, 102), ...ids(1),
      way(1, [[47.05, 8.30], [47.051, 8.301]]),
    ]);
    expect(lines(cell)).toEqual([{ k: "bus", n: "2 · Horw => Luzern", c: "#8dc63f", w: [1] }]);
  });

  it("doesn't list a ferry twice when its way is also in a ferry route", () => {
    const cell = toCell([
      rel({ type: "route", route: "ferry", name: "Luzern – Vitznau" }), ...ids(4),
      way(4, [[47.05, 8.31], [47.0, 8.48]], { route: "ferry" }),
    ]);
    expect(lines(cell)).toEqual([{ k: "boat", n: "Luzern – Vitznau", w: [4] }]);
  });

  it("lists each stop once with every line calling there (the halt and its platform a few metres apart are one stop)", () => {
    const cell = toCell([
      rel({ type: "route", route: "bus", ref: "1" }), ...ids(1), ...stopIds(11, 12, 20),
      rel({ type: "route", route: "bus", ref: "2" }), ...ids(1), ...stopIds(12, 30),
      way(1, [[47.05, 8.30], [47.06, 8.31]]),
      stop(11, 47.0500, 8.3000, "Luzern, Bahnhof"), stop(12, 47.0502, 8.3003, "Luzern, Bahnhof"),
      stop(20, 47.0550, 8.3050, "Kantonalbank"), stop(30, 47.0590, 8.3090, "Schwanenplatz"),
    ]);
    expect(cell.s).toEqual([
      [47.05, 8.3, "Luzern, Bahnhof", [0, 1]],
      [47.055, 8.305, "Kantonalbank", [0]],
      [47.059, 8.309, "Schwanenplatz", [1]],
    ]);
  });
});
