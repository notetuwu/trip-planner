// Geocoding with a disk cache and a queue in two lanes (Nominatim and Photon, side by side); the page polls for results.
import type { GeoHit, GeoQuery, LatLng, ReverseHit } from "../../shared/types";
import { errMsg } from "../config";
import { diskCache } from "../util/disk-cache";
import { nominatim, nominatimHit, photon, photonHit } from "./providers";

export type GeoEntry = GeoHit | ReverseHit | null;
export const geoCache = diskCache<GeoEntry | number>("geocode.json");
// Cache v2 added the Photon fallback: retry everything v1 couldn't find. v3 prefers a town's own point over the middle
// of its municipality: look up again what was answered with a boundary.
if (geoCache.data.__v !== 3) {
  for (const k of Object.keys(geoCache.data)) {
    const v = geoCache.data[k];
    if (v === null || (geoCache.data.__v === 2 && typeof v === "object" && (v as GeoHit).kind === "administrative")) delete geoCache.data[k];
  }
  geoCache.data.__v = 3;
}

/**
 * The best of Nominatim's answers: the first, except that a municipality's boundary gives way to the town of the same
 * name. A boundary's point is the middle of its area, which for a village like Hallstatt is up in the mountains,
 * kilometres from the village itself.
 */
export function bestHit(hits: any[]) {
  const [first] = hits;
  if (!first) return undefined;
  const cat = (h: any) => h.category || h.class;
  if (cat(first) === "boundary") return hits.find((h) => cat(h) === "place" && h.name === first.name) || first;
  return first;
}

/** The "near" point (rounded to ~10 km) is part of the key only when given, so older cache entries stay valid. */
export const geoKey = (q: string, cc?: string, near?: LatLng | null, stop = false) =>
  `${String(q).trim().toLowerCase()}|${cc || ""}${near ? `|${(+near[0]).toFixed(1)},${(+near[1]).toFixed(1)}` : ""}${stop ? "|s2" : ""}`;

/**
 * `near` keeps results around that point, e.g. the town an itinerary stop is in, so a "Gasthaus zur Post"
 * is found in the right village rather than anywhere in the country.
 */
export async function geocodeOne(q: string, cc?: string, near?: LatLng | null, stop = false): Promise<GeoHit | null> {
  return (await byNominatim(q, cc, near, stop)) || byPhoton(q, cc, near);
}

/** Nominatim: exact towns (the place, not the middle of its municipality), and for stops their website and names. */
/**
 * The name cut before extras saved places often carry ("GREEN BOWL 北浜 | COFFEE & SALAD", "LAMP LAMP produced by
 * SAMPLEWORKS 渋谷PARCO", "Steak Sample (Main shop)"), for when the whole name isn't found. Shorter guesses (only the
 * Japanese part, only the first words) were tried and gave wrong places, so there's just this one.
 */
export function nameVariants(q: string): string[] {
  const [name, ...rest] = q.split(",");
  const where = rest.length ? `,${rest.join(",")}` : "";
  const cut = name.replace(/\s*(\||｜|\s[-–—]\s|\(|（|\bproduced by\b|・).*$/i, "").trim();
  return cut && cut !== name.trim() ? [`${cut}${where}`] : [];
}

/** A found place's name shares a real word with the name looked up (so a cut-down name doesn't land on a stranger). */
export function sameWord(found: string, wanted: string) {
  const words = (wanted.split(",")[0].toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]{2,}|[\p{L}\p{N}]{4,}/gu) || []);
  const f = found.toLowerCase();
  return words.some((w) => f.includes(w));
}

async function byNominatim(q: string, cc?: string, near?: LatLng | null, stop = false): Promise<GeoHit | null> {
  const ask = async (text: string) => {
    const params = new URLSearchParams({ q: text, format: "jsonv2", limit: "3", addressdetails: "1", "accept-language": "en" });
    if (stop) { params.set("extratags", "1"); params.set("namedetails", "1"); } // its website and all its names
    if (cc) params.set("countrycodes", cc);
    if (near) {
      const [lat, lng] = near, d = 0.6; // roughly 50-65 km around the point
      params.set("viewbox", `${lng - d},${lat + d},${lng + d},${lat - d}`);
      params.set("bounded", "1");
    }
    return bestHit(await nominatim("search", params));
  };
  // The name as given, then other ways of writing it (see nameVariants). A shorter form only counts when it finds an
  // actual place (a shop, sight, park…), not a district or town that happens to share a word of the name.
  const first = await ask(q);
  if (first) return nominatimHit(first);
  for (const text of nameVariants(q)) {
    const hit = await ask(text);
    if (hit && !["place", "boundary", "highway"].includes(hit.category || hit.class) && sameWord(String(hit.name || hit.display_name || ""), text)) return nominatimHit(hit);
  }
  return null;
}

/** Photon: better at fuzzy shop and sight names; also tried with the name cut before " - ", " | " or "(" (e.g.
 *  "Store - Shibuya Main Store"). */
async function byPhoton(q: string, cc?: string, near?: LatLng | null): Promise<GeoHit | null> {
  const ccs = (cc || "").split(",").filter(Boolean);
  const km = (f: any) => {
    if (!near) return 0;
    const [lng, lat] = f.geometry.coordinates, r = Math.PI / 180;
    return Math.hypot((lng - near[1]) * Math.cos(lat * r), lat - near[0]) * 111;
  };
  // "…, Austria": only answers in that country (Photon happily finds an "Alpine Centre" in Australia otherwise).
  const named = countryCode(q.split(",").at(-1) || "");
  for (const name of new Set([q, q.replace(/\s+[-–|(].*$/, "")])) {
    const pp = new URLSearchParams({ q: name, limit: "5", lang: "en" });
    if (near) { pp.set("lat", String(near[0])); pp.set("lon", String(near[1])); }
    const f = (await photon(pp))
      .find((f) => {
        const fc = (f.properties.countrycode || "").toLowerCase();
        return (!ccs.length || ccs.includes(fc)) && (!named || !fc || fc === named) && km(f) < 60;
      });
    if (f) return photonHit(f);
  }
  return null;
}

let countries: Map<string, string> | null = null;
/** The ISO code of a country named in English ("Austria" → "at"), or "" if it isn't a country's name. */
export function countryCode(name: string) {
  if (!countries) {
    countries = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try { const n = names.of(code); if (n && n !== code) countries.set(n.toLowerCase(), code.toLowerCase()); } catch { /* not a region */ }
    }
  }
  return countries.get(name.trim().toLowerCase()) || "";
}

/**
 * Two lanes that work side by side, each at its service's pace: Nominatim (one a second) and Photon (faster). A job
 * starts in the lane that answers it best (stays and stops: Nominatim, for exact towns and stops' websites; saved
 * places: Photon, which is quick and good with shop and sight names) and moves to the other lane if not found there,
 * instead of holding up its lane while it waits.
 */
type Lane = "nominatim" | "photon";
interface GeoJob { q: string; cc?: string; near: LatLng | null; key: string; first: boolean; stop: boolean; lane: Lane; tried: Lane[]; errored?: boolean; answered?: boolean }
const geoQueue: GeoJob[] = [];
const busy: Record<Lane, boolean> = { nominatim: false, photon: false };
/** Being looked up right now (out of the queue meanwhile, so the page asking again doesn't queue it twice). */
const inFlight = new Set<string>();
const other = (l: Lane): Lane => (l === "nominatim" ? "photon" : "nominatim");
/** A service that keeps failing (down, or unreachable from here) is left out for a while: its jobs go to the other. */
const failures: Record<Lane, number> = { nominatim: 0, photon: 0 };
const downUntil: Record<Lane, number> = { nominatim: 0, photon: 0 };
const isDown = (l: Lane) => Date.now() < downUntil[l];
export const startLane = (j: { first: boolean; stop: boolean }): Lane => {
  const best: Lane = j.first || j.stop ? "nominatim" : "photon";
  return isDown(best) && !isDown(other(best)) ? other(best) : best;
};

/** What the lookups did lately, for the panel over the map ("what's it doing?"). */
export interface GeoEvent { at: number; q: string; lane: Lane; result: "found" | "none" | "error" | "moved"; name?: string; error?: string; ms: number }
const events: GeoEvent[] = [];
const logEvent = (e: GeoEvent) => { events.push(e); if (events.length > 80) events.splice(0, events.length - 80); };
/** The lookups right now: what each lane is on, what's waiting, which service is left out, and what happened lately. */
export function geocodeStatus() {
  return {
    queued: geoQueue.length,
    waiting: geoQueue.slice(0, 8).map((j) => ({ q: j.q, lane: j.lane })),
    now: [...current.entries()].map(([lane, j]) => ({ lane, q: j.q, since: j.since })),
    down: (["nominatim", "photon"] as Lane[]).filter(isDown).map((lane) => ({ lane, until: downUntil[lane] })),
    events: events.slice(-40).reverse(),
  };
}
const current = new Map<Lane, { q: string; since: number }>();

async function runLane(lane: Lane) {
  if (busy[lane]) return;
  busy[lane] = true;
  for (let i; (i = geoQueue.findIndex((j) => j.lane === lane)) >= 0;) {
    const job = geoQueue.splice(i, 1)[0];
    // This service is left out for now: the job goes straight to the other one (if that one hasn't had it yet).
    if (isDown(lane)) {
      if (!job.tried.includes(other(lane)) && !isDown(other(lane))) { job.lane = other(lane); geoQueue.push(job); runLane(job.lane); continue; }
      // Both had their go (or the other is down too): keep what's known, try again another time otherwise.
      if (job.answered) { geoCache.data[job.key] = null; geoCache.save(); }
      continue;
    }
    inFlight.add(job.key);
    current.set(lane, { q: job.q, since: Date.now() });
    const t0 = Date.now();
    let hit: GeoHit | null = null, failed = "";
    try { hit = lane === "nominatim" ? await byNominatim(job.q, job.cc, job.near, job.stop) : await byPhoton(job.q, job.cc, job.near); }
    catch (e) { failed = errMsg(e); }
    current.delete(lane);
    inFlight.delete(job.key);
    job.tried.push(lane);
    if (failed) {
      job.errored = true;
      // Three failures in a row: the service is down or unreachable from here; leave it out for 10 minutes.
      if (++failures[lane] >= 3 && !isDown(lane)) {
        downUntil[lane] = Date.now() + 10 * 60e3;
        console.error(`Geocode: ${lane} keeps failing (${failed}); using only the other service for 10 minutes.`);
      } else if (failures[lane] < 3) console.error(`Geocode (${lane}) failed:`, job.q, failed);
    } else { failures[lane] = 0; job.answered = true; }
    const moving = !hit && !job.tried.includes(other(lane)) && !isDown(other(lane));
    logEvent({ at: Date.now(), q: job.q, lane, ms: Date.now() - t0, result: failed ? "error" : hit ? "found" : moving ? "moved" : "none", ...(hit ? { name: hit.label || hit.name } : {}), ...(failed ? { error: failed } : {}) });
    if (moving) {
      // Not found here (or failed): the other lane tries it, keeping its place among the others there.
      job.lane = other(lane);
      const at = geoQueue.findIndex((j) => j.lane === job.lane && !j.first && job.first);
      geoQueue.splice(at < 0 ? geoQueue.length : at, 0, job);
      runLane(job.lane);
      continue;
    }
    // Remember the answer, including "not found" when a service did answer; only when every try failed is nothing kept,
    // so it's tried again later (instead of coming back on every check forever).
    if (hit || job.answered) { geoCache.data[job.key] = hit; geoCache.save(); }
  }
  busy[lane] = false;
}

/** Answers what's cached right away and queues the rest; the page asks again for those. */
export function geocodeBatch(queries: GeoQuery[]) {
  const results: Record<string, unknown> = {};
  let pending = 0;
  for (const { q, cc, near: n, first, stop } of queries.slice(0, 1000)) {
    const near = Array.isArray(n) && n.length === 2 && n.every(isFinite) ? (n.map(Number) as LatLng) : null;
    if (!q || !String(q).trim()) continue;
    const key = geoKey(q, cc, near, !!stop);
    if (key in geoCache.data) { results[key] = geoCache.data[key]; continue; }
    pending++;
    if (inFlight.has(key)) continue;
    const queued = geoQueue.findIndex((x) => x.key === key);
    const job: GeoJob = { q: String(q).trim(), cc, near, key, first: !!first, stop: !!stop, lane: startLane({ first: !!first, stop: !!stop }), tried: [] };
    // Stays and itinerary stops jump ahead of the (often long) saved-places backlog, but stay in the order they
    // were asked for among themselves (a day's town must be found before the stops searched around it).
    if (first && !geoQueue[queued]?.first) {
      if (queued >= 0) { job.lane = geoQueue[queued].tried.length ? geoQueue[queued].lane : job.lane; job.tried = geoQueue[queued].tried; geoQueue.splice(queued, 1); }
      const at = geoQueue.findIndex((x) => !x.first);
      geoQueue.splice(at < 0 ? geoQueue.length : at, 0, job);
    } else if (queued < 0) geoQueue.push(job);
  }
  runLane("nominatim"); runLane("photon");
  return { results, pending, queued: geoQueue.length };
}

/** A town's location, looked up now if it isn't cached (used before fetching places around it). */
export async function locateTown(q: string, cc?: string): Promise<GeoHit | null> {
  const key = geoKey(q, cc);
  if (!(key in geoCache.data)) { geoCache.data[key] = await geocodeOne(q, cc); geoCache.save(); }
  return geoCache.data[key] as GeoHit | null;
}
