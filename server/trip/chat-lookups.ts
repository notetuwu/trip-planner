// Lookups the trip chat can ask for before it answers, instead of answering from memory: where a place is (with how far
// it is from the trip's towns), a road route between two places, or a web search. The model writes LOOKUP lines; the
// results go back to it and it's asked again (see companion.ts). They work the same with every model.
import type { LatLng } from "../../shared/types";
import { errMsg } from "../config";
import { bestHit, countryCode, geocodeOne } from "../geo/geocode";
import { nominatim, nominatimHit } from "../geo/providers";
import { waitForRoute } from "../geo/routing";
import { webSearch } from "../research/search";

export interface Lookup { kind: "place" | "route" | "search"; args: string[] }
export interface Town { name: string; lat: number; lng: number }

const LINE = /^[ \t>*`-]*LOOKUP:\s*(place|route|search)\s*\|\s*(.+?)[ \t`]*$/gim;

/** The LOOKUP lines in a reply (at most `max`). */
export function parseLookups(text: string, max = 3): Lookup[] {
  const out: Lookup[] = [];
  for (const m of text.matchAll(LINE)) {
    const args = m[2].split("|").map((s) => s.trim().slice(0, 160)).filter(Boolean);
    if (args.length) out.push({ kind: m[1].toLowerCase() as Lookup["kind"], args });
    if (out.length >= max) break;
  }
  return out;
}

/** A reply without its LOOKUP lines (what's left to show, if anything). */
export const withoutLookups = (text: string) => text.replace(LINE, "").trim();

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371;
};

/** "12 km from Vaduz" (straight line) for the nearest two of the trip's towns. */
function nearest(at: { lat: number; lng: number }, towns: Town[]) {
  return towns.map((t) => ({ t, d: km(at, t) })).sort((a, b) => a.d - b.d).slice(0, 2)
    .map(({ t, d }) => `${d < 1 ? `${Math.round(d * 1000)} m` : `${d < 10 ? d.toFixed(1) : Math.round(d)} km`} from ${t.name}`).join(", ");
}

/** Other ways a name is written on the map: "Schloss Hohenzollern, Hechingen, Germany" is "Hohenzollern Castle" there, and
 *  an address-like string with a town in the middle finds nothing, so also the name with only its country, and alone. */
export function nameVariants(q: string): string[] {
  const parts = q.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [];
  const [name, ...rest] = parts, country = rest.length ? rest[rest.length - 1] : "";
  const castle = name.match(/^(?:Schloss|Burg|Ch[aâ]teau|Castello|Castillo|Castelo|Schloß)\s+(.+)$/i);
  const names = [name, ...(castle ? [`${castle[1]} Castle`] : [])];
  const out = [parts.join(", ")];
  for (const n of names) {
    if (rest.length > 1) out.push(`${n}, ${country}`);
    if (rest.length) out.push(n);
  }
  if (castle) out.splice(1, 0, `${castle[1]} Castle`);
  return [...new Set(out)];
}

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** A place from its name: coordinates as given, else the name tried in its other spellings on Nominatim (the first that
 *  finds something), and only then the fuzzier search the map uses. */
async function findPlace(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const c = q.match(COORDS);
  if (c && Math.abs(+c[1]) <= 90 && Math.abs(+c[2]) <= 180) return { lat: +c[1], lng: +c[2], label: `${(+c[1]).toFixed(4)}, ${(+c[2]).toFixed(4)}` };
  const cc = countryCode(q.split(",").at(-1) || "");
  for (const v of nameVariants(q)) {
    const params = new URLSearchParams({ q: v, format: "jsonv2", limit: "3", addressdetails: "1", "accept-language": "en" });
    if (cc) params.set("countrycodes", cc);
    const hit = bestHit((await nominatim("search", params)) as any[], v);
    if (hit) { const h = nominatimHit(hit); return { lat: h.lat, lng: h.lng, label: h.label }; }
  }
  return geocodeOne(q);
}

async function place(name: string, towns: Town[]) {
  const params = new URLSearchParams({ q: name, format: "jsonv2", limit: "3", addressdetails: "1", "accept-language": "en", extratags: "1" });
  let raw = (await nominatim("search", params)) as any[];
  // Nothing under that spelling: its other spellings (see nameVariants).
  for (const v of raw.length ? [] : nameVariants(name).slice(1)) {
    raw = (await nominatim("search", new URLSearchParams({ q: v, format: "jsonv2", limit: "3", addressdetails: "1", "accept-language": "en", extratags: "1" }))) as any[];
    if (raw.length) break;
  }
  const hits = raw.map(nominatimHit);
  if (!hits.length) return `Nothing found for "${name}" on OpenStreetMap. Try another spelling, or the place plus its town.`;
  return hits.map((h) => `- ${h.name} (${h.kind || "place"}): ${h.label} · at ${h.lat.toFixed(5)},${h.lng.toFixed(5)}${towns.length ? ` · ${nearest(h, towns)} (straight line)` : ""}${h.website ? ` · ${h.website}` : ""}`).join("\n");
}

const duration = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`);

/** The road route through two or more places in order (the map's own routing service): each leg, and the total. */
async function route(stops: string[]) {
  const found: Awaited<ReturnType<typeof findPlace>>[] = [];
  for (const s of stops) found.push(await findPlace(s));
  const missing = stops.find((_, i) => !found[i]);
  if (missing) return `Couldn't find "${missing}" on the map. Try the place plus its town and country.`;
  const hits = found as NonNullable<(typeof found)[number]>[];
  const lines: string[] = [];
  let meters = 0, secs = 0;
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1], b = hits[i];
    const r = await waitForRoute("car", [a.lat, a.lng] as LatLng, [b.lat, b.lng] as LatLng, 25_000);
    const crow = km(a, b);
    if (!r) { lines.push(`${a.label} → ${b.label}: no road route found (${crow.toFixed(1)} km in a straight line).`); continue; }
    meters += r.d; secs += r.t;
    lines.push(`${a.label} → ${b.label}: ${(r.d / 1000).toFixed(1)} km by road, about ${duration(Math.round(r.t / 60))} driving (${crow.toFixed(1)} km in a straight line).`);
  }
  if (hits.length > 2) lines.push(`Total: ${(meters / 1000).toFixed(1)} km, about ${duration(Math.round(secs / 60))} driving, without stops.`);
  return lines.join("\n");
}

/** Runs the lookups; each result is labelled with what was asked. */
export async function runLookups(lookups: Lookup[], towns: Town[], onStatus: (s: string) => void): Promise<string> {
  const out: string[] = [];
  for (const l of lookups) {
    const what = `${l.kind}: ${l.args.join(" | ")}`;
    onStatus(l.kind === "search" ? `Searching the web for "${l.args[0]}"…` : l.kind === "route" ? `Looking up the route ${l.args.join(" → ")}…` : `Looking up where ${l.args[0]} is…`);
    try {
      const text = l.kind === "place" ? await place(l.args.join(", "), towns)
        : l.kind === "route" ? (l.args.length >= 2 ? await route(l.args.slice(0, 5)) : "A route needs two places: LOOKUP: route | from | to")
        : (await webSearch(l.args.join(" "))).slice(0, 3000);
      out.push(`### ${what}\n${text}`);
    } catch (e) { out.push(`### ${what}\nFailed: ${errMsg(e)}`); }
  }
  return out.join("\n\n");
}
