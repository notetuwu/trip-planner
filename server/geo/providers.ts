// OpenStreetMap geocoders: Nominatim (search and reverse) and Photon (better at fuzzy shop and sight names).
// Both are free public services, each paced on its own: Nominatim allows one request a second (we use 1.1 s), Photon
// asks for fair use (we use 0.4 s). Separate paces let the two work side by side.
import type { GeoHit } from "../../shared/types";
import { USER_AGENT } from "../config";

/** One request at a time per service, at least `gap` ms apart. */
function pacer(gap: number) {
  let next = 0;
  return async () => {
    const wait = Math.max(0, next - Date.now());
    next = Math.max(Date.now(), next) + gap;
    await new Promise((r) => setTimeout(r, wait));
  };
}
const nominatimSlot = pacer(1100), photonSlot = pacer(400);

export async function nominatim(endpoint: "search" | "reverse", params: URLSearchParams): Promise<any> {
  await nominatimSlot();
  const res = await fetch(`https://nominatim.openstreetmap.org/${endpoint}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

export async function photon(params: URLSearchParams): Promise<any[]> {
  await photonSlot();
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

export function nominatimHit(hit: any): GeoHit {
  const site = String(hit.extratags?.website || hit.extratags?.["contact:website"] || hit.extratags?.url || "").split(";")[0].trim();
  return {
    lat: +hit.lat, lng: +hit.lon, name: hit.name || hit.display_name.split(",")[0], label: hit.display_name,
    country: hit.address?.country || "", cc: (hit.address?.country_code || "").toLowerCase(), kind: hit.type || "",
    ...(/^https?:\/\//.test(site) ? { website: site } : {}),
    ...(hit.namedetails ? { names: [...new Set(Object.values(hit.namedetails as Record<string, string>))].slice(0, 12) } : {}),
  };
}
