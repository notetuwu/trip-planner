// "Map file": the trip as KML or GPX for other map apps (shared/map-file.ts writes them). The stays where they were
// located, each day's stops where the map has them, and each day's route along the roads and rails the map drew
// (straight lines where it has none).
import { type MapModel, toGpx, toKml } from "../../../shared/map-file";
import { downloadFile } from "../core/dom";
import { dayColor, fmtDate, fmtTime } from "../core/format";
import { state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, tripCountries } from "../geo/locate";
import { dayLegs, legRoute } from "../map/routes";

export function mapModel(): MapModel {
  const it = state.itinerary!, byTitle = byTitleMap();
  const name = it.destination || tripCountries().map(([, n]) => n).join(" & ") || "Trip";
  return {
    name,
    stays: state.stays.map((s) => ({ s, l: stayLoc(s) })).filter((x) => x.l).map(({ s, l }) => ({
      name: s.city.split(",")[0], lat: l!.lat, lng: l!.lng,
      desc: [s.hotel, s.start ? `${fmtDate(s.start)} · ${s.nights} night${Number(s.nights) === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
    })),
    days: it.days.map((d, i) => {
      const stops = d.items.flatMap((x, xi) => {
        const l = itemLoc(x, d, byTitle);
        return l ? [{ name: `${xi + 1}. ${x.place.split(",")[0]}`, lat: l.lat, lng: l.lng, desc: [fmtTime(x.time), x.description].filter(Boolean).join(" · ") }] : [];
      });
      // The legs one after another, each along its route where the map knows one.
      const line: [number, number][] = [];
      for (const leg of dayLegs(d, byTitle)) {
        const pts = legRoute(leg)?.c || [leg.from, leg.to];
        for (const [lat, lng] of pts) { const last = line[line.length - 1]; if (!last || last[0] !== lat || last[1] !== lng) line.push([lat, lng]); }
      }
      return { name: `Day ${i + 1} · ${fmtDate(d.date) || d.date} · ${d.city.split(",")[0]}`, color: dayColor(i), stops, line };
    }),
  };
}

/** Saves the trip as a KML or a GPX file. */
export function downloadMapFile(kind: "kml" | "gpx") {
  if (!state.itinerary) return;
  const m = mapModel(), base = m.name.replace(/[^\p{L}\p{N}-]+/gu, "-");
  downloadFile(new Blob([kind === "kml" ? toKml(m) : toGpx(m)], { type: kind === "kml" ? "application/vnd.google-earth.kml+xml" : "application/gpx+xml" }), `${base}.${kind}`);
}
