// The map with English place names (Munich, Cologne, Osaka): OpenFreeMap's vector map drawn by MapLibre inside
// Leaflet, with every name label switched to the English name where one exists. Loaded only when chosen, since the
// renderer is large.
import "maplibre-gl/dist/maplibre-gl.css";
import { maplibreGL } from "@maplibre/maplibre-gl-leaflet";
import type * as L from "leaflet";
import type { Map as GlMap } from "maplibre-gl";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const ENGLISH = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]];

/** Name labels in English; road-number shields hidden (they clutter the map). */
function useEnglish(gl: GlMap) {
  for (const layer of gl.getStyle().layers) {
    if (layer.type !== "symbol") continue;
    if (/shield/.test(layer.id)) { gl.setLayoutProperty(layer.id, "visibility", "none"); continue; }
    const text = gl.getLayoutProperty(layer.id, "text-field");
    if (text && JSON.stringify(text).includes("name")) gl.setLayoutProperty(layer.id, "text-field", ENGLISH as never);
  }
}

export function englishLayer(): L.Layer {
  const layer = maplibreGL({
    style: STYLE,
    attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  } as never) as unknown as L.Layer & { getMaplibreMap(): GlMap };
  layer.on("add", () => {
    const gl = layer.getMaplibreMap();
    if (gl.isStyleLoaded()) useEnglish(gl); else gl.once("load", () => useEnglish(gl));
  });
  return layer;
}
