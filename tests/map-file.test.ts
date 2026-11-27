import { describe, expect, it } from "vitest";
import { type MapModel, kmlColor, toGpx, toKml } from "../shared/map-file";

const model: MapModel = {
  name: "Lakes & castles",
  stays: [{ name: "Lucerne", lat: 47.0502, lng: 8.3093, desc: "Hotel Seeblick · 3 nights" }],
  days: [{
    name: "Day 1 · Sat, 5 Sept · Lucerne", color: "#e4572e",
    stops: [{ name: "1. Kapellbrücke", lat: 47.0517, lng: 8.3075, desc: "10:00" }, { name: "2. Café <Rio> & co", lat: 47.0485, lng: 8.3098 }],
    line: [[47.0517, 8.3075], [47.05, 8.309], [47.0485, 8.3098]],
  }, { name: "Day 2 · Sun, 6 Sept · Lucerne", color: "#2b8a3e", stops: [], line: [] }],
};

describe("map files", () => {
  it("writes colours the way KML wants them", () => {
    expect(kmlColor("#e4572e")).toBe("ff2e57e4");
  });

  it("makes KML: the stays, a folder per day with its stops and route, names escaped", () => {
    const k = toKml(model);
    expect(k).toContain("<name>Lakes &amp; castles</name>");
    expect(k).toContain("<Folder><name>Stays</name>");
    expect(k).toContain("<coordinates>8.3093,47.0502,0</coordinates>");
    expect(k).toContain("<name>2. Café &lt;Rio&gt; &amp; co</name>");
    expect(k).toContain("<coordinates>8.3075,47.0517,0 8.309,47.05,0 8.3098,47.0485,0</coordinates>");
    expect(k).toContain("<color>ff2e57e4</color>");
    expect(k.match(/<Folder>/g)?.length).toBe(3);
  });

  it("makes GPX: waypoints for the stays and stops, a track for each day with a route", () => {
    const g = toGpx(model);
    expect(g).toContain(`<wpt lat="47.0502" lon="8.3093"><name>Lucerne</name>`);
    expect(g).toContain("<sym>Lodging</sym>");
    expect(g.match(/<wpt /g)?.length).toBe(3);
    expect(g.match(/<trk>/g)?.length).toBe(1);
    expect(g).toContain(`<trkpt lat="47.05" lon="8.309"/>`);
  });
});
