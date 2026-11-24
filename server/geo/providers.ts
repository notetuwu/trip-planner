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
// Photon asks for fair use: 0.3 s between requests (the lane runs a few at once, so the pace is what limits it).
// Geoapify's free plan allows 5 requests a second.
const nominatimSlot = pacer(1100), photonSlot = pacer(300), geoapifySlot = pacer(220);

/** Geoapify (OpenStreetMap data, fast, needs a free key: 3,000 lookups a day). */
export async function geoapify(params: URLSearchParams, key: string): Promise<any[]> {
  await geoapifySlot();
  params.set("apiKey", key);
  const res = await fetch(`https://api.geoapify.com/v1/geocode/search?${params}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8_000) });
  if (res.status === 401 || res.status === 403) throw new Error("Geoapify: the key was refused");
  if (!res.ok) throw new Error(`Geoapify HTTP ${res.status}`);
  return ((await res.json()) as any).features || [];
}

export function geoapifyHit(f: any): GeoHit {
  const p = f.properties || {};
  const street = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
  const name = p.name || street || p.city || p.village || p.town || "";
  return { lat: p.lat ?? f.geometry.coordinates[1], lng: p.lon ?? f.geometry.coordinates[0], name, label: p.formatted || name, country: p.country || "", cc: (p.country_code || "").toLowerCase(), kind: p.result_type || "" };
}

export async function nominatim(endpoint: "search" | "reverse", params: URLSearchParams): Promise<any> {
  await nominatimSlot();
  const res = await fetch(`https://nominatim.openstreetmap.org/${endpoint}?${params}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

export async function photon(params: URLSearchParams): Promise<any[]> {
  await photonSlot();
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8_000) });
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
