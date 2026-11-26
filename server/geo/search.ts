// The map's search box and "what's at this point" for clicks on the map.
import type { GeoHit, ReverseHit } from "../../shared/types";
import { errMsg } from "../config";
import { geoCache } from "./geocode";
import { nominatim, nominatimHit, photon, photonHit } from "./providers";

/** Looks like an address: a number in it ("Rathausplatz 1", "1-22-14 Udagawachō"), or Japanese or Chinese script. */
export const looksLikeAddress = (q: string) => /\d/.test(q) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(q);

const kmBetween = (a: GeoHit, b: GeoHit) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) * 111.2;

/** Name search: Photon biased to the map view, Nominatim as a fallback; places in the trip's countries first.
 *  `quick`: asked as they type, so Photon only (Nominatim's rules don't allow a search per key press). An address searched
 *  for (not quick) asks both, as each finds addresses the other doesn't; when neither finds the house number, the street
 *  or area without it (marked "near"). */
export async function searchPlaces(q: string, lat: number, lng: number, cc: string, quick = false): Promise<GeoHit[]> {
  const ccs = (cc || "").split(",").filter(Boolean);
  const address = !quick && looksLikeAddress(q);
  // For an address, Nominatim answers in the local names ("1, Rathausplatz, Wien", not "City Hall Square") and Photon in
  // English ("Udagawachō, Shibuya", not "宇田川町"), so what was typed matches one of them, in either script.
  const byPhoton = async (text: string) => {
    const params = new URLSearchParams({ q: text, limit: "8", lang: "en" });
    if (isFinite(lat) && isFinite(lng)) { params.set("lat", String(lat)); params.set("lon", String(lng)); }
    try { return (await photon(params)).map(photonHit); } catch (e) { console.error("Photon:", errMsg(e)); return []; }
  };
  const byNominatim = async (text: string) => {
    const np = new URLSearchParams({ q: text, format: "jsonv2", limit: "6", addressdetails: "1", ...(address ? {} : { "accept-language": "en" }) });
    if (cc) np.set("countrycodes", cc);
    try { return ((await nominatim("search", np)) as unknown[]).map(nominatimHit); } catch (e) { console.error("Nominatim:", errMsg(e)); return []; }
  };
  if (!address) {
    let hits = await byPhoton(q);
    if (!hits.length && !quick) hits = await byNominatim(q);
    return hits.sort((a, b) => Number(ccs.includes(b.cc)) - Number(ccs.includes(a.cc)));
  }
  // How well a result matches the address: the words typed (street, area, town) it has, then its numbers.
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = [...new Set(norm(q).split(/[^\p{L}]+/u).filter((w) => w.length >= 3 && /^\p{Script=Latin}+$/u.test(w)))];
  const nums = [...new Set(q.match(/\d+/g) || [])];
  const fit = (h: GeoHit) => {
    const text = norm(`${h.name}, ${h.label}`);
    return { words: words.filter((w) => text.includes(w)).length, nums: nums.filter((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text)).length };
  };
  const center = { lat, lng } as GeoHit;
  const ranked = (hits: GeoHit[]) => hits.map((h) => ({ h, f: fit(h) })).sort((a, b) => b.f.words - a.f.words || b.f.nums - a.f.nums
    || Number(ccs.includes(b.h.cc)) - Number(ccs.includes(a.h.cc)) || (isFinite(lat) ? kmBetween(a.h, center) - kmBetween(b.h, center) : 0));
  /** Both services, the same place once; somewhere outside the trip's countries (a "31-2" abroad) left out. */
  const both = async (text: string) => {
    const [n, p] = await Promise.all([byNominatim(text), byPhoton(text)]);
    return [...n, ...p.filter((h) => !n.some((x) => kmBetween(x, h) < 0.05))].filter((h) => !ccs.length || ccs.includes(h.cc));
  };
  let found = ranked(await both(q));
  // Not found with all of what was typed (no such number, or a building in the next district): the street or area too.
  if (!found.length || found[0].f.words < words.length || (nums.length && !found[0].f.nums)) {
    const area = q.replace(/[\d０-９]+(?:\s*[-‐−ー－丁目番地号の]\s*[\d０-９]*)*[丁目番地号]?/g, " ").replace(/\s*,\s*,/g, ",").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s{2,}/g, " ");
    if (area && area !== q && area.replace(/[\s,]/g, "").length >= 2) {
      const more = (await both(area)).filter((h) => !found.some((x) => kmBetween(x.h, h) < 0.05));
      found = ranked([...found.map((x) => x.h), ...more]);
    }
  }
  // Without any of the numbers typed: the street or area it's in, not the address itself.
  return found.map(({ h, f }) => (nums.length && !f.nums ? { ...h, near: true } : h));
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
