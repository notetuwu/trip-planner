// Public transport lines for the map's overlays (bus, tram, metro, train, boat, cable car), from OpenStreetMap's route
// data via the public Overpass servers. The map asks by area: fixed cells of about 5 × 5 km, each fetched once and kept
// on disk, one small file per cell, for 90 days. A public server takes about as long for four cells as for one (most of
// the time is its queue), so cells are fetched four at a time (a 2 × 2 block) and the answer split up here; and the
// Swiss server, many times quicker, fetches the cells in and around Switzerland alongside the main one.
import fs from "node:fs";
import { type LocalStop, orderStops } from "../../shared/line-order";
import path from "node:path";
import { CACHE_DIR, USER_AGENT, errMsg, sleep } from "../config";
import { OVERPASS } from "../trip/overpass";
import { working } from "../util/activity";
import { readSettings, writeSettings } from "../settings";

export type LineKind = "bus" | "tram" | "metro" | "train" | "boat" | "lift";
/** One line in a cell (both directions together): its kind, label ("5 · Kriens – Luzern"), colour as OpenStreetMap has
 *  it, the ids of its ways in the cell, and of its routes (one per direction: for the line's full list of stops). */
export interface TransitLine { k: LineKind; n: string; c?: string; w: number[]; r?: number[] }
/** A stop in the cell: where, its name, and the lines that call there (indexes into the cell's lines). */
export type TransitStop = [lat: number, lng: number, name: string, lines: number[]];
/** A cell: its lines, the shape of each way they use, once ([lat, lng] points, 5 decimals; a way can come in pieces
 *  where it leaves the cell), and its stops (cells fetched before stops were added have none, and get them later). */
export interface LinesCell { l: TransitLine[]; w: Record<number, [number, number][][]>; s?: TransitStop[] }

/** Cell size in degrees, and how cells are named: "<row>_<col>" of the grid. */
export const CELL = 0.05;
// Version 2 has the lines' colours from their route masters: areas kept from before are fetched again.
/** Where the downloads are kept: the folder set in Settings, else the app's cache folder. Areas in "lines-v2" (version 2
 *  has the lines' colours from their route masters), lines' stops in "lines-routes". */
let root = readSettings().linesDir || CACHE_DIR;
const cellsDir = () => path.join(root, "lines-v2");
const routesDir = () => path.join(root, "lines-routes");
fs.rmSync(path.join(CACHE_DIR, "lines"), { recursive: true, force: true });
const MAX_AGE = 90 * 864e5;
const CELL_ID = /^-?\d{1,4}_-?\d{1,4}$/;

const KIND: Record<string, LineKind> = {
  bus: "bus", trolleybus: "bus", tram: "tram", light_rail: "tram", subway: "metro", monorail: "metro", train: "train",
  ferry: "boat", funicular: "lift", aerialway: "lift",
};

function kindOf(tags: Record<string, string>): LineKind | null {
  if (tags.type === "route") return KIND[tags.route] || null;
  if (tags.route === "ferry") return "boat";
  if (tags.aerialway || tags.railway === "funicular") return "lift";
  return null;
}

/** A colour the map can draw: "#e30613", "#E36", or a plain CSS colour name. */
const colour = (c?: string) => (c && /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]{3,20})$/i.test(c.trim()) ? c.trim() : undefined);

/** "5 · Kriens – Luzern": the line's number and its name (without the number repeated). */
function label(tags: Record<string, string>) {
  const ref = tags.ref?.trim(), name = (tags.name || tags["name:en"] || "").trim();
  const ends = tags.from && tags.to ? `${tags.from} – ${tags.to}` : "";
  if (!ref) return name || ends;
  // "Bus 5: Kriens => Luzern" or "5: Kriens => Luzern" as the name: the number goes in front once.
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = name.replace(new RegExp(`^(?:[\\p{L}-]+\\s+)?${esc}\\s*[:\\-–]\\s*`, "iu"), "").trim();
  if (!rest || rest === ref) return ref;
  // "S-Bahn S41" names its number already.
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(rest) ? rest : `${ref} · ${rest}`;
}

const bboxOf = (id: string) => {
  const [r, c] = id.split("_").map(Number);
  return { s: r * CELL, w: c * CELL, n: (r + 1) * CELL, e: (c + 1) * CELL };
};

/** The Overpass query for an area: each route's tags followed by the ids of its ways in the area (not its whole member
 *  list: a train route lists a whole country), then every way once with its shape cut to the area, plus ferry and lift
 *  ways that aren't in a route, then the stops. Sharing the ways keeps a city cell around half a megabyte, not tens. */
const areaQuery = (bb: string) => `[out:json][timeout:120];
    rel["type"="route"]["route"~"^(bus|trolleybus|tram|light_rail|subway|monorail|train|ferry|funicular|aerialway)$"](${bb})->.r;
    rel(br.r)["type"="route_master"]; out body qt;
    foreach.r->.rt(.rt out tags; way(r.rt)(${bb}); out ids; node(r.rt)(${bb}); out ids;);
    (way(r.r)(${bb}); way["route"="ferry"](${bb}); way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift)$"](${bb}); way["railway"="funicular"](${bb}););
    out geom(${bb}) qt;
    node(r.r)(${bb}); out qt;`;

/** The Swiss server holds Switzerland and a strip around it (Como, Bregenz, Konstanz, Vaduz complete; Lindau, 20 km
 *  out, already missing some routes). Roughly the border, [lat, lng]: a cell whose middle is inside goes there. */
const SWISS: [number, number][] = [[47.59, 7.56], [47.61, 8.23], [47.81, 8.68], [47.66, 8.86], [47.65, 9.18], [47.48, 9.56], [47.45, 9.65],
  [47.05, 9.50], [46.98, 9.88], [46.98, 10.47], [46.62, 10.47], [46.35, 10.05], [46.23, 10.15], [46.37, 9.45], [46.25, 9.23],
  [45.82, 9.03], [46.11, 8.70], [46.25, 8.04], [45.93, 7.87], [45.87, 7.17], [46.13, 5.96], [46.40, 6.06], [46.73, 6.43],
  [47.00, 6.83], [47.45, 6.99], [47.50, 7.40]];
export function inSwissReach(id: string) {
  const { s, w, n, e } = bboxOf(id), y = (s + n) / 2, x = (w + e) / 2;
  let inside = false;
  for (let i = 0, j = SWISS.length - 1; i < SWISS.length; j = i++) {
    const [yi, xi] = SWISS[i], [yj, xj] = SWISS[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const SWISS_SERVER = "https://overpass.osm.ch/api/interpreter";

/** Servers that couldn't be reached or turned us away, and until when they're left alone (asked last, if at all). */
const downUntil = new Map<string, number>();
export const serverDown = (url: string) => (downUntil.get(url) || 0) > Date.now();
/** A connection that couldn't be made (the server is away, or not letting this computer in), as opposed to a slow answer. */
const unreachable = (e: unknown) => /ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|UND_ERR_CONNECT|connect timeout|fetch failed/i
  .test(`${(e as Error)?.message} ${String((e as { cause?: unknown })?.cause ?? "")} ${((e as { cause?: { code?: string } })?.cause?.code) ?? ""}`);

/** Asks the servers in turn (twice round) for an area; the elements of the answer. `lv`: the worker's status, which the
 *  panel and the grid show. */
async function fetchArea(bb: string, servers: string[], lv: Live): Promise<any[]> {
  const q = areaQuery(bb);
  let lastErr: unknown;
  for (let round = 0; round < 2; round++) {
    if (round) await wait(10000, "all servers busy, trying again", lv);
    // Those that just failed last; skipped while another is up.
    const order = [...servers.filter((u) => !serverDown(u)), ...servers.filter(serverDown)];
    for (const url of order) {
      if (serverDown(url) && order.some((u) => !serverDown(u))) continue;
      try {
        lv.server = new URL(url).host; lv.bytes = 0; lv.firstByte = 0; lv.asked = Date.now();
        // The main server gives each visitor two slots, locked for a while after a heavy query: wait for a free one
        // (it says when) rather than being turned away and trying the slower backups.
        await waitForSlot(url, lv);
        lv.asked = Date.now();
        // A cancel (from the map or the panel) stops it at once, waiting or not.
        const signal = () => AbortSignal.any([AbortSignal.timeout(135000), lv.stop.signal]);
        let res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: signal() });
        if (res.status === 429 && await waitForSlot(url, lv)) {
          res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: signal() });
        }
        // Turned away (too many requests from here): left alone for a few minutes, the next server is asked.
        if (res.status === 429) downUntil.set(url, Date.now() + 3 * 60_000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Read as it comes, counting, so the map can show how much has arrived and how fast.
        const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!lv.firstByte) lv.firstByte = Date.now();
          chunks.push(value);
          lv.bytes += value.length;
        }
        const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as any;
        lv.lastBytes = lv.bytes;
        // "Query timed out" or "out of memory" comes as a normal answer with a remark, and only part of the data: not
        // kept as if it were the whole area.
        if (/error|timed out|out of memory/i.test(String(json.remark || ""))) throw new Error(String(json.remark).slice(0, 160));
        const els = json.elements || [];
        // Nothing at all from the Swiss server: likely outside what it holds (an empty area is asked of another).
        if (url === SWISS_SERVER && !els.length) throw new Error("nothing from the Swiss server");
        return els;
      } catch (err) {
        if (lv.stop.signal.aborted) throw new Error("cancelled");
        // Couldn't connect at all: not asked again for ten minutes (each try costs half a minute of waiting).
        if (unreachable(err)) { downUntil.set(url, Date.now() + 10 * 60_000); console.error(`Overpass server ${new URL(url).host} can't be reached; using the others for now.`); }
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

const cellOf = (lat: number, lon: number) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

/**
 * A block's answer cut into its cells: for each, the routes and their masters as they are, the ways' and stops' ids
 * of those in the cell, each way's shape within it (with the points just outside, so a line runs on to the cell's
 * edge), and the stops in it. In the answer's order, which toCell reads.
 */
export function splitArea(elements: any[], ids: string[]): Map<string, any[]> {
  const out = new Map(ids.map((id) => [id, [] as any[]]));
  const where = new Map<number, string>();
  for (const el of elements) if (el.type === "node" && typeof el.lat === "number") where.set(el.id, cellOf(el.lat, el.lon));
  /** Each way's shape per cell (nulls where it's away from the cell, as Overpass marks points outside the area). */
  const shapes = new Map<number, Map<string, Pt[]>>();
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const g: Pt[] = el.geometry, at = g.map((p) => (p ? cellOf(p.lat, p.lon) : ""));
    const per = new Map<string, Pt[]>();
    for (const id of new Set(at.filter((c) => out.has(c)))) {
      const cut = g.map((p, i) => (p && (at[i] === id || at[i - 1] === id || at[i + 1] === id) ? p : null));
      per.set(id, cut);
    }
    shapes.set(el.id, per);
  }
  for (const el of elements) {
    for (const [id, list] of out) {
      if (el.type === "relation") list.push(el);
      else if (el.type === "way" && el.geometry) { const cut = shapes.get(el.id)?.get(id); if (cut) list.push({ ...el, geometry: cut }); }
      else if (el.type === "way") { if (shapes.get(el.id)?.has(id)) list.push(el); }
      else if (el.type === "node" && where.get(el.id) === id) list.push(el);
    }
  }
  return out;
}

const kmBetween = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * r), y = b[0] - a[0];
  return Math.hypot(x, y) * 111.2;
};

/** A pause the panel can show ("waiting for a free slot on overpass-api.de: 12 s"). */
async function wait(ms: number, why: string, lv: Live) {
  lv.retryAt = Date.now() + ms; lv.why = why;
  try {
    // Over at once when the download is cancelled.
    await new Promise<void>((done) => { const t = setTimeout(done, ms); lv.stop.signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); });
    if (lv.stop.signal.aborted) throw new Error("cancelled");
  } finally { lv.retryAt = 0; lv.why = ""; }
}

/** On the main Overpass server: waits until one of our slots is free (its status page says in how many seconds), up to
 *  two minutes. True when it waited (so a refused query is worth asking again). */
/** A line's stops being looked up right now (the area downloads hold off meanwhile). */
let lookups = 0;

/** The main server has a slot free for us right now (other servers: always assumed). */
async function slotFree(url: string) {
  if (!url.startsWith("https://overpass-api.de/")) return true;
  if (serverDown(url)) return false;
  try {
    const res = await fetch("https://overpass-api.de/api/status", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
    return /[1-9]\d* slots? available now/i.test(await res.text());
  } catch { return false; }
}

async function waitForSlot(url: string, lv: Live) {
  if (!url.startsWith("https://overpass-api.de/") || serverDown(url)) return false;
  try {
    const res = await fetch("https://overpass-api.de/api/status", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (/(\d+) slots? available now/i.test(text) && !/^0 slots/im.test(text)) return false;
    const secs = [...text.matchAll(/in (\d+) seconds?/gi)].map((m) => +m[1]);
    if (!secs.length) return false;
    await wait(Math.min(120, Math.min(...secs) + 1) * 1000, "waiting for a free slot on overpass-api.de", lv);
    return true;
  } catch { return false; }
}

/** What a worker is doing right now, for the Layers panel and the grid: the cells it's fetching (since when, from which
 *  server, when it asked, bytes so far and when the first came: Overpass thinks first, then sends), its pause, its last. */
interface Live {
  cells: string[]; started: number; server: string; asked: number; bytes: number; firstByte: number; retryAt: number; why: string;
  lastBytes: number; nextAt: number; last: null | { cells: number; bytes: number; stored: number; ms: number; ok: boolean; server: string; cancelled?: boolean };
  /** Cancels what it's fetching now. */
  stop: AbortController;
}
const newLive = (): Live => ({ cells: [], started: 0, server: "", asked: 0, bytes: 0, firstByte: 0, retryAt: 0, why: "", lastBytes: 0, nextAt: 0, last: null, stop: new AbortController() });
const lives: Record<"main" | "main2" | "swiss", Live> = { main: newLive(), main2: newLive(), swiss: newLive() };
/** Background downloads wait while a plan is being made. */
let paused = false;

/** How the download is going, for the panel (polled about once a second while it's open): each worker's part. */
export function linesProgress() {
  const now = Date.now();
  const workers = (Object.entries(lives) as [keyof typeof lives, Live][]).map(([kind, lv]) => ({
    kind, server: lv.server, ids: lv.cells,
    cells: lv.cells.length, secs: lv.cells.length ? Math.round((now - lv.started) / 1000) : 0,
    /** Since it asked the server it's on now (after waiting for a slot, or moving on from another server). */
    askedSecs: lv.cells.length && lv.asked ? Math.round((now - lv.asked) / 1000) : 0,
    bytes: lv.bytes,
    // Speed over the time data has been arriving (before that, the server is still working out the answer).
    speed: lv.firstByte && now > lv.firstByte + 300 ? Math.round(lv.bytes / ((now - lv.firstByte) / 1000)) : 0,
    retryIn: lv.retryAt > now ? Math.ceil((lv.retryAt - now) / 1000) : 0, why: lv.why,
    nextIn: !lv.cells.length && lv.nextAt > now ? Math.ceil((lv.nextAt - now) / 1000) : 0,
    running: running[kind], last: lv.last,
  }));
  /** Servers left alone for now (couldn't be reached, or turned us away), and for how much longer. */
  const down = [...downUntil].filter(([, t]) => t > now).map(([url, t]) => ({ server: new URL(url).host, secs: Math.ceil((t - now) / 1000) }));
  return { workers, paused, down, left: { view: view.length, background: background.length } };
}

type Pt = { lat: number; lon: number } | null;
/** A way's shape inside the cell: points outside it (null) end a piece. */
function pieces(geometry: Pt[] | undefined) {
  const res: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const g of geometry || []) {
    if (!g) { if (cur.length > 1) res.push(cur); cur = []; continue; }
    cur.push([+g.lat.toFixed(5), +g.lon.toFixed(5)]);
  }
  if (cur.length > 1) res.push(cur);
  return res;
}

/** Long-distance coaches (Flixbus to Lisbon) run through every city centre: not what a city's bus map is for. */
const COACH = /flixbus|blablabus|eurolines|regiojet|ouibus|national express|megabus/i;

/** The answer as a cell: each route (its tags, then its ways' and stops' ids) merged with its other direction, the
 *  shapes, and the stops with the lines that call there. */
export function toCell(elements: any[]): LinesCell {
  const shapes: LinesCell["w"] = {}, byLine = new Map<string, TransitLine>(), loose: TransitLine[] = [];
  const lineStops = new Map<TransitLine, Set<number>>(), nodes = new Map<number, { lat: number; lon: number; name: string }>();
  // Each line as a whole (route master) lists its routes: its colour is theirs when they have none (common for buses).
  // Asked once for the whole cell, not per route, which kept Overpass busy for minutes.
  const masterColour = new Map<number, string>();
  for (const el of elements) {
    const c = el.type === "relation" && el.tags?.type === "route_master" ? colour(el.tags.colour) : undefined;
    if (c) for (const m of el.members || []) if (m.type === "relation") masterColour.set(m.ref, c);
  }
  let cur: TransitLine | null = null;
  for (const el of elements) {
    if (el.type === "relation" && el.tags?.type === "route_master") {
      // The line as a whole, right after its route: its colour when the route has none (common for city buses).
      const c = colour(el.tags.colour);
      if (cur && !cur.c && c) cur.c = c;
      continue;
    }
    if (el.type === "relation") {
      const tags = el.tags || {}, k = kindOf(tags);
      cur = null;
      if (!k || tags.bus === "coach" || COACH.test(`${tags.name || ""} ${tags.network || ""} ${tags.operator || ""}`)) continue;
      // Both directions (and variants) of a line are one line: same kind, number and colour.
      const c = colour(tags.colour) || masterColour.get(el.id);
      const key = `${k}|${tags.ref || tags.name || el.id}|${c || ""}`;
      cur = byLine.get(key) || null;
      if (!cur) { cur = { k, n: label(tags), ...(c ? { c } : {}), w: [], r: [] }; byLine.set(key, cur); lineStops.set(cur, new Set()); }
      if (!cur.r!.includes(el.id)) cur.r!.push(el.id);
    } else if (el.type === "node") {
      // Right after a route: the ids of its stops in the cell. At the end: the stops themselves, where and what.
      if (typeof el.lat === "number") nodes.set(el.id, { lat: el.lat, lon: el.lon, name: (el.tags?.name || el.tags?.["name:en"] || "").trim() });
      else if (cur) lineStops.get(cur)!.add(el.id);
    } else if (el.type === "way" && el.geometry) {
      const p = pieces(el.geometry);
      if (p.length) shapes[el.id] = p;
      // A ferry or lift way: a line of its own, unless a route has it (checked below).
      const tags = el.tags || {}, k = kindOf(tags);
      if (k && p.length) loose.push({ k, n: tags.name || (k === "lift" ? "Cable car" : "Ferry"), w: [el.id] });
    } else if (el.type === "way" && cur && !cur.w.includes(el.id)) cur.w.push(el.id);
  }
  // Only lines with a shape in the cell, and only the shapes some line uses.
  const kept = [...byLine.values()].filter((x) => x.w.some((id) => shapes[id]));
  const routed = kept.map((x) => ({ ...x, w: x.w.filter((id) => shapes[id]) }));
  const inRoute = new Set(routed.flatMap((x) => x.w));
  const l = [...routed, ...loose.filter((x) => !inRoute.has(x.w[0]))];
  const used = new Set(l.flatMap((x) => x.w));
  return { l, w: Object.fromEntries(Object.entries(shapes).filter(([id]) => used.has(+id))), s: stopsOf(kept, lineStops, nodes) };
}

/** The cell's stops, each with the lines calling there. A stop often comes twice (where the bus halts, and the platform
 *  where people wait, a few metres apart): same name close by is one stop. */
function stopsOf(lines: TransitLine[], lineStops: Map<TransitLine, Set<number>>, nodes: Map<number, { lat: number; lon: number; name: string }>): TransitStop[] {
  const byNode = new Map<number, Set<number>>();
  lines.forEach((line, i) => { for (const id of lineStops.get(line) || []) { if (!byNode.has(id)) byNode.set(id, new Set()); byNode.get(id)!.add(i); } });
  const out: { lat: number; lng: number; name: string; lines: Set<number> }[] = [];
  const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => kmBetween([a.lat, a.lng], [b.lat, b.lng]) * 1000;
  for (const [id, ls] of byNode) {
    const n = nodes.get(id);
    if (!n) continue;
    const at = { lat: n.lat, lng: n.lon };
    const same = out.find((s) => (n.name ? s.name === n.name && metres(s, at) < 120 : !s.name && metres(s, at) < 30));
    if (same) { for (const x of ls) same.lines.add(x); continue; }
    out.push({ ...at, name: n.name, lines: new Set(ls) });
  }
  return out.map((s) => [+s.lat.toFixed(5), +s.lng.toFixed(5), s.name, [...s.lines].sort((a, b) => a - b)]);
}

const file = (id: string) => path.join(cellsDir(), `${id}.json`);
function cached(id: string): LinesCell | undefined {
  try {
    const f = file(id), st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > MAX_AGE) return undefined;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return undefined; }
}

/** On disk and not too old (without reading it: the grid asks about hundreds of cells at a time). */
function isCached(id: string) {
  try { return Date.now() - fs.statSync(file(id)).mtimeMs <= MAX_AGE; } catch { return false; }
}

/**
 * What's fetched next: the cells someone is looking at (the latest view replaces the last, middle of the screen first),
 * then the background's (the trip's areas, with any in view moved to the front), slowly.
 */
let view: string[] = [];
let background: string[] = [];
/** Cells kept from before stops were added, that someone looked at: fetched again (with stops) when nothing else is waiting. */
let upgrade: string[] = [];
/** The cells being fetched right now, for the grid. */
const current = new Set<string>();
/** Cells that just failed: not asked again for 10 minutes. */
const failed = new Map<string, number>();
const recentlyFailed = (id: string) => Date.now() - (failed.get(id) || 0) < 10 * 60_000;
/** Cells whose download was cancelled: left alone until someone downloads them by hand ("Download this area"), or the
 *  planner starts again. */
const cancelled = new Set<string>();
const todo = (id: string) => !isCached(id) && !recentlyFailed(id) && !current.has(id) && !cancelled.has(id);

/** Stops the downloads of these cells (the whole request each is part of) and leaves them alone from now on. */
export function cancelLines(ids: string[]) {
  const asked = new Set(cellIds(ids, 400));
  for (const lv of Object.values(lives)) if (lv.cells.some((id) => asked.has(id))) { for (const id of lv.cells) asked.add(id); lv.stop.abort(); }
  for (const id of asked) cancelled.add(id);
  view = view.filter(todo); background = background.filter(todo); upgrade = upgrade.filter((id) => !cancelled.has(id));
  return { cancelled: asked.size };
}
/** The main server gives each visitor two slots: two workers use them; the Swiss server has its own. */
const running = { main: false, main2: false, swiss: false };

/** The 2 × 2 block a cell is in, as its four cells. */
function blockOf(id: string) {
  const [r, c] = id.split("_").map(Number), r0 = Math.floor(r / 2) * 2, c0 = Math.floor(c / 2) * 2;
  return [`${r0}_${c0}`, `${r0}_${c0 + 1}`, `${r0 + 1}_${c0}`, `${r0 + 1}_${c0 + 1}`];
}

/** Starts the workers that aren't running (each stops when there's nothing left for it). */
function run() {
  if (!running.main) worker("main");
  if (!running.swiss) worker("swiss");
  // The second slot, a moment later (so the two don't take the same block).
  if (!running.main2) { running.main2 = true; setTimeout(() => worker("main2"), 500); }
}

/**
 * One worker: takes the next cell (the view's first, then the background's), fetches its block's cells not on disk
 * (one query for all of them; a single cell's own when it's the only one), and keeps them. The Swiss worker takes only
 * cells within its server's reach; the main one takes the others, and those too when the Swiss one is busy.
 */
async function worker(kind: "main" | "main2" | "swiss") {
  running[kind] = true;
  const mine = (id: string) => (kind === "swiss" ? inSwissReach(id) : !inSwissReach(id) || !running.swiss);
  const lv = lives[kind];
  try {
    for (;;) {
      view = view.filter(todo);
      background = background.filter(todo);
      upgrade = upgrade.filter((id) => !recentlyFailed(id) && !current.has(id));
      const fg = view.some(mine);
      if (!fg && !background.some(mine) && !upgrade.some(mine)) break;
      if (!fg) {
        // Background: never while a plan is being made (it asks Overpass too). Anything someone looks at meanwhile goes first.
        while (working() && !view.length) { paused = true; await sleep(5000); }
        paused = false;
        if (view.some(mine)) continue;
      }
      // The downloads being moved to another folder: wait for that.
      while (moving) await sleep(500);
      // A line's stops being looked up: that goes first (up to half a minute), then the next area.
      for (let t = 0; lookups > 0 && t < 30; t++) await sleep(1000);
      // The second download on the main server is for its second slot: while it's away, the others aren't doubled up on.
      if (kind === "main2" && serverDown(OVERPASS[0])) break;
      const id = (fg ? view : background.some(mine) ? background : upgrade).find(mine);
      if (!id || current.has(id)) continue;
      const isUpgrade = !fg && !background.includes(id);
      // With it, the other cells of its block not on disk yet (or, for an old cell without stops, just that one).
      // (Only cells someone wants: the view's, the trip's. Not the rest of the block, which may be outside the trip.)
      const wanted = new Set([...view, ...background]);
      const cells = isUpgrade ? [id] : blockOf(id).filter((c) => c === id || (wanted.has(c) && todo(c)));
      for (const c of cells) current.add(c);
      view = view.filter((c) => !cells.includes(c)); background = background.filter((c) => !cells.includes(c)); upgrade = upgrade.filter((c) => c !== id);
      const t0 = Date.now();
      Object.assign(lv, { cells, started: t0, bytes: 0, firstByte: 0, lastBytes: 0, asked: 0, server: "", stop: new AbortController() });
      let stored = 0, ok = true;
      try {
        const box = cells.map(bboxOf), bb = `${Math.min(...box.map((b) => b.s))},${Math.min(...box.map((b) => b.w))},${Math.max(...box.map((b) => b.n))},${Math.max(...box.map((b) => b.e))}`;
        const servers = kind === "swiss" ? [SWISS_SERVER, ...OVERPASS] : OVERPASS;
        const els = await fetchArea(bb, servers, lv);
        const parts = cells.length === 1 ? new Map([[id, els]]) : splitArea(els, cells);
        fs.mkdirSync(cellsDir(), { recursive: true });
        for (const c of cells) {
          const json = JSON.stringify(toCell(parts.get(c) || []));
          fs.writeFileSync(file(c), json);
          stored += Buffer.byteLength(json);
        }
      } catch (e) {
        ok = false;
        if (lv.stop.signal.aborted) { console.log(`Transport lines for ${cells.join(", ")}: cancelled`); }
        else for (const c of cells) failed.set(c, Date.now());
        console.error(`Transport lines for ${cells.length > 1 ? `cells ${cells.join(", ")}` : `cell ${id}`} failed:`, errMsg(e));
      }
      for (const c of cells) current.delete(c);
      lv.last = { cells: cells.length, bytes: lv.lastBytes, stored, ms: Date.now() - t0, ok, server: lv.server, ...(lv.stop.signal.aborted ? { cancelled: true } : {}) };
      lv.cells = [];
      // Volunteer-run servers: a pause after each query (longer in the background; the Swiss server is quick).
      const gap = kind === "swiss" ? 1000 : fg ? 1500 : 3000;
      lv.nextAt = Date.now() + gap;
      await sleep(gap);
      lv.nextAt = 0;
    }
  } finally { running[kind] = false; }
}

const cellIds = (ids: string[], max: number) => [...new Set(ids.filter((x) => CELL_ID.test(x)))].slice(0, max);

/**
 * Downloads these cells ahead, in the background (the trip's areas; the list replaces the last one, so a changed trip
 * doesn't keep fetching the old one's). `first`: the cells in view, fetched before the rest. Answers how many are ready
 * and how many are still to come.
 */
export function prefetchLines(ids: string[], first: string[] = [], again: string[] = []) {
  for (const id of cellIds(again, 400)) cancelled.delete(id);
  const want = cellIds(ids, 1500), front = new Set(cellIds(first, 400));
  const left = want.filter(todo);
  background = [...left.filter((id) => front.has(id)), ...left.filter((id) => !front.has(id))];
  run();
  const ready = want.filter(isCached).length;
  return { total: want.length, ready, left: background.length + want.filter((id) => current.has(id)).length, failed: want.filter((id) => !isCached(id) && recentlyFailed(id)).length };
}

/** How much the downloaded lines take on disk, and forgetting them all. */
export function linesOnDisk() {
  let files = 0, bytes = 0;
  try { for (const d of [cellsDir(), routesDir()]) for (const f of fs.readdirSync(d)) { if (d === cellsDir()) files++; bytes += fs.statSync(path.join(d, f)).size; } } catch { /* none yet */ }
  return { areas: files, bytes };
}
export function clearLines() {
  background = []; view = []; upgrade = [];
  fs.rmSync(cellsDir(), { recursive: true, force: true });
  fs.rmSync(routesDir(), { recursive: true, force: true });
}

/**
 * The lines of the cells in view that are ready, and how many are still being fetched. The cells come middle of the
 * screen first; those not ready become the view's list (replacing the last view's), fetched before anything else.
 */
export function linesFor(ids: string[]) {
  const cells: Record<string, LinesCell> = {};
  const missing: string[] = [];
  for (const id of cellIds(ids, 200)) {
    const hit = cached(id);
    if (hit) {
      cells[id] = hit;
      // From before stops: shown as it is, and fetched again with its stops once nothing else is waiting.
      if (!hit.s && !upgrade.includes(id) && !current.has(id)) upgrade.push(id);
      continue;
    }
    // Failed a moment ago, or cancelled: nothing for now (and not asked for again while it's in view).
    if (recentlyFailed(id) || cancelled.has(id)) { cells[id] = { l: [], w: {} }; continue; }
    missing.push(id);
  }
  view = missing.filter((id) => !current.has(id));
  run();
  return { cells, pending: missing.length };
}

/** For the map's grid: which of these cells are downloaded, being fetched now, waiting, or failed. */
export function cellStatus(ids: string[]) {
  const asked = cellIds(ids, 2000), waiting = new Set([...view, ...background]);
  return {
    done: asked.filter(isCached),
    now: asked.filter((id) => current.has(id)),
    /** Each worker's cells in view, its server and how long it's been at them. */
    jobs: Object.values(lives).filter((lv) => lv.cells.some((id) => asked.includes(id)))
      .map((lv) => ({ cells: lv.cells, server: lv.server, secs: Math.round((Date.now() - lv.started) / 1000) })),
    waiting: asked.filter((id) => waiting.has(id) && !current.has(id)),
    failed: asked.filter((id) => !isCached(id) && recentlyFailed(id)),
  };
}

// ---- A line's stops, in order (clicking a line in the map's stop card). -------------------------------------------

/**
 * A line's stops in order from the downloaded areas, at once: starting at the area of the stop it was opened from,
 * every neighbouring downloaded area the line runs through (at most 300), its pieces joined and the stops sorted along
 * them (shared/line-order.ts). The line is known by its routes (its two directions have different names). Null when
 * no downloaded area has it.
 */
export function localLine(routeIds: number[], lat: number, lng: number): { name: string; stops: LocalStop[]; areas: number; edge: boolean } | null {
  const want = new Set(routeIds.filter((x) => Number.isInteger(x) && x > 0));
  if (!want.size || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const start = `${Math.floor(lat / CELL)}_${Math.floor(lng / CELL)}`;
  const seen = new Set([start]), queue = [start], pieces: [number, number][][] = [], stops = new Map<string, LocalStop>();
  let name = "", areas = 0, edge = false;
  while (queue.length && areas < 300) {
    const id = queue.shift()!, cell = cached(id);
    // An area not downloaded next to one the line runs through: the list stops there.
    if (!cell) { if (areas) edge = true; continue; }
    const mine = cell.l.map((l, i) => (l.r?.some((r) => want.has(r)) ? i : -1)).filter((i) => i >= 0);
    if (!mine.length) continue;
    areas++;
    for (const i of mine) {
      name ||= cell.l[i].n;
      for (const w of cell.l[i].w) pieces.push(...(cell.w[w] || []));
    }
    for (const [la, ln, nm, idx] of cell.s || []) {
      if (!idx.some((i) => mine.includes(i))) continue;
      // The same stop in two areas (or its two platforms) once.
      const key = `${nm}|${la.toFixed(3)},${ln.toFixed(3)}`;
      if (!stops.has(key)) stops.set(key, { name: nm, lat: la, lng: ln });
    }
    const [r, c] = id.split("_").map(Number);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const next = `${r + dr}_${c + dc}`;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  if (!areas) return null;
  // One stop's platforms on either side of the road (or in neighbouring areas): once.
  const list: LocalStop[] = [];
  for (const s of orderStops([...stops.values()], pieces)) {
    const prev = list.at(-1);
    if (prev && prev.name === s.name && kmBetween([prev.lat, prev.lng], [s.lat, s.lng]) < 0.4) continue;
    list.push(s);
  }
  return { name, stops: list, areas, edge };
}

export interface RouteStops { id: number; name: string; ref: string; colour?: string; stops: { name: string; lat: number; lng: number }[] }

/**
 * The stops of one route (one direction of a line) in the order it calls at them, with names and where they are: asked
 * of Overpass once (a small query), then kept on disk for 90 days. A stop's halt and platform are one stop.
 */
export async function routeStops(id: number): Promise<RouteStops | null> {
  return (await routesStops([id]))[id] ?? null;
}

const routeFile = (id: number) => path.join(routesDir(), `${id}.json`);
function keptRoute(id: number): RouteStops | undefined {
  try { const f = routeFile(id); if (Date.now() - fs.statSync(f).mtimeMs <= MAX_AGE) return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* not yet */ }
  return undefined;
}
/** Routes being asked for now (a line clicked while the stop's card is fetching its lines waits for that answer). */
const asking = new Map<number, Promise<RouteStops | null>>();

/**
 * The stops of several routes (the lines at a stop, fetched when its card opens so a click on one is quick): those
 * kept on disk, and the others in one query. By route id; null for a route OpenStreetMap doesn't have.
 */
export async function routesStops(ids: number[]): Promise<Record<number, RouteStops | null>> {
  const out: Record<number, RouteStops | null> = {}, missing: number[] = [], waits: Promise<void>[] = [];
  for (const id of [...new Set(ids)].filter((x) => Number.isInteger(x) && x > 0).slice(0, 40)) {
    const kept = keptRoute(id);
    if (kept) out[id] = kept;
    else if (asking.has(id)) waits.push(asking.get(id)!.then((r) => { out[id] = r; }));
    else missing.push(id);
  }
  if (missing.length) {
    // A small query someone is waiting for: it doesn't queue behind the area downloads. While it runs they don't start
    // another area, and when the main server's slots are taken (by those downloads) a backup answers it instead.
    const all = (async () => {
      lookups++;
      try {
        // Both servers at once, the first good answer wins: either can take a minute when it's busy (the main one
        // queues even small queries for half a minute at times).
        const order = (await slotFree(OVERPASS[0])) ? OVERPASS : [...OVERPASS.slice(1), OVERPASS[0]];
        return await Promise.any(order.map((url) => askRoutes(missing, [url]))).catch((e: AggregateError) => { throw e.errors?.[0] ?? e; });
      } finally { lookups--; }
    })();
    // (Each waiter's own copy; one nobody waits for fails quietly.)
    for (const id of missing) { const one = all.then((r) => r[id] ?? null); one.catch(() => {}); asking.set(id, one); }
    try { Object.assign(out, await all); } finally { for (const id of missing) asking.delete(id); }
  }
  await Promise.all(waits);
  return out;
}

async function askRoutes(ids: number[], servers: string[]): Promise<Record<number, RouteStops | null>> {
  const q = `[out:json][timeout:40]; rel(id:${ids.join(",")}); out body; node(r); out qt;`;
  let lastErr: unknown;
  for (const url of servers) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(50000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as any;
      const nodes = new Map<number, any>((json.elements || []).filter((e: any) => e.type === "node").map((e: any) => [e.id, e]));
      const out: Record<number, RouteStops | null> = {};
      for (const id of ids) {
        const route = (json.elements || []).find((e: any) => e.type === "relation" && e.id === id);
        out[id] = route ? routeOf(route, nodes) : null;
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** One route's stops in order, from its members, kept on disk. */
function routeOf(route: any, nodes: Map<number, any>): RouteStops {
  const id: number = route.id;
  const stops: RouteStops["stops"] = [];
  for (const m of route.members || []) {
    // Stops and platforms (a route's other node members are rare); a halt right after its platform is the same stop.
    if (m.type !== "node" || (m.role && !/stop|platform/.test(m.role))) continue;
    const n = nodes.get(m.ref);
    if (!n) continue;
    const name = (n.tags?.name || n.tags?.["name:en"] || "").trim();
    const prev = stops[stops.length - 1];
    if (prev && (prev.name === name || kmBetween([prev.lat, prev.lng], [n.lat, n.lon]) < 0.03)) continue;
    stops.push({ name, lat: +n.lat.toFixed(5), lng: +n.lon.toFixed(5) });
  }
  const t = route.tags || {};
  const out: RouteStops = { id, name: label(t) || t.name || "", ref: t.ref || "", ...(colour(t.colour) ? { colour: colour(t.colour) } : {}), stops };
  fs.mkdirSync(routesDir(), { recursive: true });
  fs.writeFileSync(routeFile(id), JSON.stringify(out));
  return out;
}

// ---- Where the downloads are kept (Settings → General → Map). ------------------------------------------------------
/** A move to another folder is going on (downloads wait for it). */
let moving = false;

/** The folder in use, and the one used when none is set. */
export const linesLocation = () => ({ dir: root, default: CACHE_DIR, custom: root !== CACHE_DIR });

/**
 * Keeps the downloads in another folder ("" = back to the app's cache folder): checks it can be written to, moves what's
 * there now across (it may be on another drive, so copied, then removed), and remembers it. Throws with a reason the
 * page can show when the folder can't be used.
 */
export async function setLinesDir(dir: string) {
  const next = dir.trim() ? path.resolve(dir.trim()) : CACHE_DIR;
  if (dir.trim() && !path.isAbsolute(dir.trim())) throw new Error("Give the folder's full path, e.g. D:\\Trip planner\\downloads");
  if (next === root) return linesLocation();
  try {
    fs.mkdirSync(next, { recursive: true });
    const probe = path.join(next, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok"); fs.rmSync(probe);
  } catch (e) { throw new Error(`Can't keep downloads there: ${errMsg(e)}`); }
  moving = true;
  try {
    for (const sub of ["lines-v2", "lines-routes"]) {
      const from = path.join(root, sub), to = path.join(next, sub);
      if (!fs.existsSync(from)) continue;
      await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: false });
      await fs.promises.rm(from, { recursive: true, force: true });
    }
    root = next;
    writeSettings({ linesDir: next === CACHE_DIR ? "" : next });
  } finally { moving = false; }
  return linesLocation();
}
