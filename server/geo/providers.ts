// OpenStreetMap geocoders: Nominatim (search and reverse) and Photon (better at fuzzy shop and sight names).
// Both are free public services; all calls share one slot per 1.1 s.
import type { GeoHit } from "../../shared/types";
import { USER_AGENT } from "../config";

let nextSlot = 0;
async function waitForSlot() {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  await new Promise((r) => setTimeout(r, wait));
}

export async function nominatim(endpoint: "search" | "reverse", params: URLSearchParams): Promise<any> {
  await waitForSlot();
  const res = await fetch(`https://nominatim.openstreetmap.org/${endpoint}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

export async function photon(params: URLSearchParams): Promise<any[]> {
  await waitForSlot();
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  return ((await res.json()) as any).features || [];
}

export function photonHit(f: any): GeoHit {
  const p = f.properties, [lng, lat] = f.geometry.coordinates;
  const street = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
  const label = [...new Set([p.name, street, p.district || p.locality, p.city || p.county, p.state, p.country].filter(Boolean))].join(", ");
  return { lat, lng, name: p.name || street || "", label, country: p.country || "", cc: (p.countrycode || "").toLowerCase(), kind: p.osm_value || "" };
}

export const nominatimHit = (hit: any): GeoHit => ({
  lat: +hit.lat, lng: +hit.lon, name: hit.name || hit.display_name.split(",")[0], label: hit.display_name,
  country: hit.address?.country || "", cc: (hit.address?.country_code || "").toLowerCase(), kind: hit.type || "",
});
