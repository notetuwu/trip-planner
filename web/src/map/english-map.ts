// The map with English place names (Munich, Cologne, Osaka): OpenFreeMap's flat "Bright" map drawn by MapLibre inside
// Leaflet, recoloured in the colours of OpenStreetMap's own map (the "Local names" one: pink motorways, orange trunk
// roads, yellow main roads, green parks, blue water, grey-brown buildings), with every name label switched to the
// English name where one exists. Loaded only when chosen, since the renderer is large. (There's no free map without a
// key that is OpenStreetMap's own in English: Wikimedia's may only be used on its own sites, CARTO's now need a key.)
import "maplibre-gl/dist/maplibre-gl.css";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import type * as L from "leaflet";
import type { Map as GlMap } from "maplibre-gl";

const STYLE = "https://tiles.openfreemap.org/styles/bright";
const ENGLISH = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]];

/** OpenStreetMap's own colours (its "Carto" style), by layer of the Bright style. */
const ROAD: [RegExp, string, string][] = [
  // [layer ids, the road's colour, its edge's]
  [/motorway/, "#e892a2", "#dc2a67"],
  [/highway-trunk(-casing)?$/, "#f9b29c", "#c84e2f"],
  [/primary|(?<!motorway-)link/, "#fcd6a4", "#a06b00"],
  [/secondary-tertiary/, "#f7fabf", "#707d05"],
  [/minor|service-track/, "#ffffff", "#bbbbbb"],
];
const FILL: Record<string, Record<string, string>> = {
  background: { "background-color": "#f2efe9" },
  "landuse-residential": { "fill-color": "#e0dfdf" },
  "landuse-suburb": { "fill-color": "#e0dfdf" },
  "landuse-commercial": { "fill-color": "#f2dad9" },
  "landuse-industrial": { "fill-color": "#ebdbe8" },
  "landuse-cemetery": { "fill-color": "#aacbaf" },
  "landuse-hospital": { "fill-color": "#ffffe5" },
  "landuse-school": { "fill-color": "#ffffe5" },
  "landuse-railway": { "fill-color": "#ebdbe8" },
  park: { "fill-color": "#c8facc" },
  "landcover-grass": { "fill-color": "#cdebb0" },
  "landcover-grass-park": { "fill-color": "#c8facc" },
  "landcover-wood": { "fill-color": "#add19e" },
  "landcover-sand": { "fill-color": "#f5e9c6" },
  water: { "fill-color": "#aad3df" },
  "water-intermittent": { "fill-color": "#aad3df" },
  building: { "fill-color": "#d9d0c9", "fill-outline-color": "#c4b6ab" },
  "building-top": { "fill-color": "#d9d0c9", "fill-outline-color": "#c4b6ab" },
  "highway-area": { "fill-color": "#ffffff", "fill-outline-color": "#bbbbbb" },
  "road_area_pier": { "fill-color": "#f2efe9" },
  "road_pier": { "line-color": "#f2efe9" },
};

/** Sets a paint property, if the layer has it (a style that changed on the server mustn't break the map). */
function paint(gl: GlMap, id: string, prop: string, value: string) {
  try { gl.setPaintProperty(id, prop, value); } catch { /* not in this style */ }
}

/** Name labels in English, OpenStreetMap's colours, road-number shields hidden (they clutter the map), nothing 3D. */
function restyle(gl: GlMap) {
  for (const layer of gl.getStyle().layers) {
    const id = layer.id;
    if (layer.type === "fill-extrusion") { gl.setLayoutProperty(id, "visibility", "none"); continue; }
    if (FILL[id]) for (const [prop, value] of Object.entries(FILL[id])) paint(gl, id, prop, value);
    if (layer.type === "line" && /^waterway/.test(id)) paint(gl, id, "line-color", "#aad3df");
    if (layer.type === "line" && /^(highway|tunnel|bridge)-/.test(id) && !/path|railway/.test(id)) {
      const road = ROAD.find(([re]) => re.test(id));
      if (road) paint(gl, id, "line-color", /casing/.test(id) ? road[2] : road[1]);
    }
    if (layer.type === "line" && /railway/.test(id) && !/hatching/.test(id)) paint(gl, id, "line-color", "#999999");
    if (layer.type !== "symbol") continue;
    if (/shield/.test(id)) { gl.setLayoutProperty(id, "visibility", "none"); continue; }
    const text = gl.getLayoutProperty(id, "text-field");
    if (text && JSON.stringify(text).includes("name")) gl.setLayoutProperty(id, "text-field", ENGLISH as never);
  }
}

/** Why the English map can't be drawn here ("" when it can): it needs WebGL, which browsers no longer fake in
 *  software when hardware acceleration is off or the graphics card is blocked. */
export function englishUnavailable(): string {
  try {
    const c = document.createElement("canvas");
    if (c.getContext("webgl2") || c.getContext("webgl")) return "";
  } catch { /* no WebGL */ }
  return "The English map needs WebGL, which this browser has switched off. Turn on “Use graphics acceleration when available” in the browser's settings (System) and restart it.";
}

const UNREACHABLE = "The English map's server (tiles.openfreemap.org) can't be reached from this browser. A blocker or the browser's tracking protection may be stopping it; allow that site, or use the local names.";

/** The English map. `failed` is told (once) when its map server can't be reached, so the caller can go back. */
export function englishLayer(failed?: (why: string) => void): L.Layer {
  const why = englishUnavailable();
  if (why) throw new Error(why);
  const layer = maplibreGL({
    style: STYLE,
    attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  } as never) as unknown as L.Layer & { getMaplibreMap(): GlMap };
  let told = false;
  layer.on("add", () => {
    const gl = layer.getMaplibreMap();
    if (gl.isStyleLoaded()) restyle(gl); else gl.once("load", () => restyle(gl));
    // The style or its tiles' description not coming at all (not one tile missing): nothing could be drawn.
    gl.on("error", (e: { error?: { message?: string; url?: string } }) => {
      const msg = String(e.error?.message || ""), url = String(e.error?.url || msg);
      if (told || !failed || !/AJAXError|NetworkError|Failed to fetch/i.test(msg) || !/\/styles\/|\/planet(\b|$)/.test(url)) return;
      told = true;
      failed(UNREACHABLE);
    });
  });
  return layer;
}
