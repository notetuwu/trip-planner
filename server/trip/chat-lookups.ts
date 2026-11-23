// Lookups the trip chat can ask for before it answers, instead of answering from memory: where a place is (with how far
// it is from the trip's towns), a road route between two places, or a web search. The model writes LOOKUP lines; the
// results go back to it and it's asked again (see companion.ts). They work the same with every model.
import type { LatLng } from "../../shared/types";
import { errMsg } from "../config";
import { geocodeOne } from "../geo/geocode";
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

async function place(name: string, towns: Town[]) {
  const params = new URLSearchParams({ q: name, format: "jsonv2", limit: "3", addressdetails: "1", "accept-language": "en", extratags: "1" });
  const hits = ((await nominatim("search", params)) as any[]).map(nominatimHit);
  if (!hits.length) return `Nothing found for "${name}" on OpenStreetMap. Try another spelling, or the place plus its town.`;
  return hits.map((h) => `- ${h.name} (${h.kind || "place"}): ${h.label} · at ${h.lat.toFixed(5)},${h.lng.toFixed(5)}${towns.length ? ` · ${nearest(h, towns)} (straight line)` : ""}${h.website ? ` · ${h.website}` : ""}`).join("\n");
}

async function route(from: string, to: string) {
  const [a, b] = await Promise.all([geocodeOne(from), geocodeOne(to)]);
  if (!a || !b) return `Couldn't find ${!a ? `"${from}"` : `"${to}"`} on the map.`;
  const r = await waitForRoute("car", [a.lat, a.lng] as LatLng, [b.lat, b.lng] as LatLng, 25_000);
  const crow = km(a, b);
  if (!r) return `${a.label} → ${b.label}: no road route found (${crow.toFixed(1)} km in a straight line).`;
  const mins = Math.round(r.t / 60);
  return `${a.label} → ${b.label}: ${(r.d / 1000).toFixed(1)} km by road, about ${mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} driving (${crow.toFixed(1)} km in a straight line). Walking takes far longer when the road climbs.`;
}

/** Runs the lookups; each result is labelled with what was asked. */
export async function runLookups(lookups: Lookup[], towns: Town[], onStatus: (s: string) => void): Promise<string> {
  const out: string[] = [];
  for (const l of lookups) {
    const what = `${l.kind}: ${l.args.join(" | ")}`;
    onStatus(l.kind === "search" ? `Searching the web for "${l.args[0]}"…` : l.kind === "route" ? `Looking up the route ${l.args.join(" → ")}…` : `Looking up where ${l.args[0]} is…`);
    try {
      const text = l.kind === "place" ? await place(l.args.join(", "), towns)
        : l.kind === "route" ? (l.args.length >= 2 ? await route(l.args[0], l.args[1]) : "A route needs two places: LOOKUP: route | from | to")
        : (await webSearch(l.args.join(" "))).slice(0, 3000);
      out.push(`### ${what}\n${text}`);
    } catch (e) { out.push(`### ${what}\nFailed: ${errMsg(e)}`); }
  }
  return out.join("\n\n");
}
