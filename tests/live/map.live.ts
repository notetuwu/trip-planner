// Where the page would put every stop of a saved trip, from the place lookups already cached on this computer: lists
// stops far from every stay of their day (the "palace shown on the other side of the continent" kind of mistake).
// Run with `npm run test:live -- map` and TRIP_FILE (a saved trip); GEOCODE_CACHE defaults to cache/geocode.json.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { state } from "../../web/src/core/state";
import { geo, geoKey } from "../../web/src/geo/geocode";
import { byTitleMap, itemLoc } from "../../web/src/geo/item-loc";
import { distKm, stayLoc } from "../../web/src/geo/locate";
import { addDays } from "../../server/config";
// The page's modules look at where they were opened from.
vi.hoisted(() => { vi.stubGlobal("location", { protocol: "http:" }); });

const FILE = process.env.TRIP_FILE || "";

describe.skipIf(!FILE)("the saved trip on the map", () => {
  it("lists stops far from their day", () => {
    const trip = JSON.parse(fs.readFileSync(FILE, "utf8")).state;
    const cache = JSON.parse(fs.readFileSync(process.env.GEOCODE_CACHE || "cache/geocode.json", "utf8"));
    Object.assign(geo, cache.data || cache);
    Object.assign(state, trip);
    const byTitle = byTitleMap();
    const far: string[] = [];
    let placed = 0, stops = 0;
    for (const d of trip.itinerary.days) {
      const stays = state.stays.filter((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0)).map(stayLoc).filter((l) => !!l);
      for (const x of d.items) {
        stops++;
        const loc = itemLoc(x, d, byTitle);
        if (!loc) continue;
        placed++;
        const km = stays.length ? Math.round(Math.min(...stays.map((s) => distKm(s!, loc)))) : 0;
        if (km > 150) far.push(`${d.date} ${x.place}: ${km} km (${loc.lat.toFixed(2)}, ${loc.lng.toFixed(2)})`);
      }
    }
    console.log(`${placed} of ${stops} stops placed, ${far.length} more than 150 km from their day's stays\n${far.join("\n")}`);
    console.log(`stays located: ${state.stays.filter((s) => geo[geoKey(s.city)]).length} of ${state.stays.length}`);
    expect(stops).toBeGreaterThan(0);
  });
});
