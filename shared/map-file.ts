// The trip as a map file for other apps: KML (Google My Maps, Google Earth, Organic Maps) or GPX (Garmin, OsmAnd,
// Organic Maps, Komoot). The stays as points, and each day as its own folder or track: its stops in order and the
// route between them. No page or server code here, so it can be tested.

export interface MapPoint { name: string; lat: number; lng: number; desc?: string }
export interface MapDay { name: string; color: string; stops: MapPoint[]; line: [number, number][] }
export interface MapModel { name: string; stays: MapPoint[]; days: MapDay[] }

const xml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const num = (n: number) => (Math.round(n * 1e6) / 1e6).toString();

/** "#e4572e" as KML writes colours: alpha, blue, green, red ("ff2e57e4"). */
export function kmlColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? `ff${m[3]}${m[2]}${m[1]}`.toLowerCase() : "ff0000ff";
}

export function toKml(m: MapModel): string {
  const place = (p: MapPoint, style: string) => `      <Placemark><name>${xml(p.name)}</name>${p.desc ? `<description>${xml(p.desc)}</description>` : ""}<styleUrl>#${style}</styleUrl><Point><coordinates>${num(p.lng)},${num(p.lat)},0</coordinates></Point></Placemark>`;
  const styles = [
    `    <Style id="stay"><IconStyle><color>ff2d00bc</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/lodging.png</href></Icon></IconStyle></Style>`,
    ...m.days.map((d, i) => `    <Style id="day${i + 1}"><IconStyle><color>${kmlColor(d.color)}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle><LineStyle><color>${kmlColor(d.color)}</color><width>4</width></LineStyle></Style>`),
  ];
  const days = m.days.map((d, i) => [
    `    <Folder><name>${xml(d.name)}</name>`,
    ...d.stops.map((p) => place(p, `day${i + 1}`)),
    ...(d.line.length > 1 ? [`      <Placemark><name>${xml(`${d.name}: route`)}</name><styleUrl>#day${i + 1}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${d.line.map(([lat, lng]) => `${num(lng)},${num(lat)},0`).join(" ")}</coordinates></LineString></Placemark>`] : []),
    `    </Folder>`,
  ].join("\n"));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<kml xmlns="http://www.opengis.net/kml/2.2">`,
    `  <Document><name>${xml(m.name)}</name>`,
    ...styles,
    ...(m.stays.length ? [`    <Folder><name>Stays</name>`, ...m.stays.map((p) => place(p, "stay")), `    </Folder>`] : []),
    ...days,
    `  </Document>`,
    `</kml>`,
    "",
  ].join("\n");
}

export function toGpx(m: MapModel): string {
  const wpt = (p: MapPoint, type: string, sym: string) => `  <wpt lat="${num(p.lat)}" lon="${num(p.lng)}"><name>${xml(p.name)}</name>${p.desc ? `<desc>${xml(p.desc)}</desc>` : ""}<sym>${sym}</sym><type>${xml(type)}</type></wpt>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Trip Planner" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata><name>${xml(m.name)}</name></metadata>`,
    ...m.stays.map((p) => wpt(p, "Stay", "Lodging")),
    ...m.days.flatMap((d) => d.stops.map((p) => wpt(p, d.name, "Flag, Blue"))),
    ...m.days.filter((d) => d.line.length > 1).map((d) => `  <trk><name>${xml(d.name)}</name><trkseg>${d.line.map(([lat, lng]) => `<trkpt lat="${num(lat)}" lon="${num(lng)}"/>`).join("")}</trkseg></trk>`),
    `</gpx>`,
    "",
  ].join("\n");
}
