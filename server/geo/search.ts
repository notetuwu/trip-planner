// The map's search box and "what's at this point" for clicks on the map.
import type { GeoHit, ReverseHit } from "../../shared/types";
import { errMsg } from "../config";
import { geoCache } from "./geocode";
import { nominatim, nominatimHit, photon, photonHit } from "./providers";

/** Name search: Photon biased to the map view, Nominatim as a fallback; places in the trip's countries first. */
/** `quick`: asked as they type, so Photon only (Nominatim's rules don't allow a search per key press). */
export async function searchPlaces(q: string, lat: number, lng: number, cc: string, quick = false): Promise<GeoHit[]> {
  const params = new URLSearchParams({ q, limit: "8", lang: "en" });
  if (isFinite(lat) && isFinite(lng)) { params.set("lat", String(lat)); params.set("lon", String(lng)); }
  let hits: GeoHit[] = [];
  try { hits = (await photon(params)).map(photonHit); } catch (e) { console.error("Photon:", errMsg(e)); }
  if (!hits.length && !quick) {
    const np = new URLSearchParams({ q, format: "jsonv2", limit: "6", addressdetails: "1", "accept-language": "en" });
    if (cc) np.set("countrycodes", cc);
    hits = (await nominatim("search", np)).map(nominatimHit);
  }
  const ccs = (cc || "").split(",").filter(Boolean);
  return hits.sort((a, b) => Number(ccs.includes(b.cc)) - Number(ccs.includes(a.cc)));
}

/**
 * What is at a clicked map point. Besides the nearest named thing (shop, sight, street…), returns the broader names
 * for the same spot (neighbourhood, town), because a click on "Venice" usually lands on some shop or cash machine;
 * the page picks one by zoom level and offers the others.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<ReverseHit | null> {
  const key = `@2:${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (!(key in geoCache.data)) {
    const hit = await nominatim("reverse", new URLSearchParams({
      lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "18", addressdetails: "1", "accept-language": "en",
    }));
    if (hit && !hit.error) {
      const a = hit.address || {};
      const town = a.city || a.town || a.village || a.municipality || "";
      const area = a.neighbourhood || a.quarter || a.suburb || a.city_district || "";
      const options = ([
        hit.name && { name: hit.name, level: "place" },
        area && { name: area, level: "area" },
        town && { name: town, level: "town" },
        !town && a.county && { name: a.county, level: "town" },
      ].filter(Boolean) as ReverseHit["options"]).filter((o, i, all) => all.findIndex((x) => x.name === o.name) === i);
      geoCache.data[key] = {
        name: hit.name || hit.display_name.split(",")[0], label: hit.display_name, options,
        short: [a.road, area, town, a.country].filter(Boolean).join(", "),
        city: town, cc: (a.country_code || "").toLowerCase(),
      };
    } else geoCache.data[key] = null;
    geoCache.save();
  }
  return geoCache.data[key] as ReverseHit | null;
}
