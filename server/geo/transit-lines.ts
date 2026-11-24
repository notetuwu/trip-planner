// Public transport lines for the map's overlays (bus, tram, metro, train, boat, cable car), from OpenStreetMap's route
// data via the public Overpass servers. The map asks by area: fixed cells of about 5 × 5 km, each fetched once (one at a
// time, gently) and kept on disk, one small file per cell, for 90 days.
import fs from "node:fs";
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

async function fetchCell(id: string): Promise<LinesCell> {
  const { s, w, n, e } = bboxOf(id), bb = `${s},${w},${n},${e}`;
  // Each route's tags followed by the ids of its ways in the cell (not its whole member list: a train route lists a
  // whole country), then every way once with its shape cut to the cell, plus ferry and lift ways that aren't in a route.
  // Sharing the ways keeps a city cell around half a megabyte instead of tens.
  const q = `[out:json][timeout:120];
    rel["type"="route"]["route"~"^(bus|trolleybus|tram|light_rail|subway|monorail|train|ferry|funicular|aerialway)$"](${bb})->.r;
    rel(br.r)["type"="route_master"]; out body qt;
    foreach.r->.rt(.rt out tags; way(r.rt)(${bb}); out ids; node(r.rt)(${bb}); out ids;);
    (way(r.r)(${bb}); way["route"="ferry"](${bb}); way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift)$"](${bb}); way["railway"="funicular"](${bb}););
    out geom(${bb}) qt;
    node(r.r)(${bb}); out qt;`;
  let lastErr: unknown;
  for (let round = 0; round < 2; round++) {
    if (round) await wait(10000, "all servers busy, trying again");
    for (const url of OVERPASS) {
      try {
        live.server = new URL(url).host; live.bytes = 0; live.firstByte = 0;
        // The main server gives each visitor two slots, locked for a while after a heavy query: wait for a free one
        // (it says when) rather than being turned away and trying the slower backups.
        await waitForSlot(url);
        let res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(135000) });
        if (res.status === 429 && await waitForSlot(url)) {
          res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(135000) });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Read as it comes, counting, so the map can show how much has arrived and how fast.
        const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!live.firstByte) live.firstByte = Date.now();
          chunks.push(value); live.bytes += value.length;
        }
        const text = Buffer.concat(chunks).toString("utf8"), json = JSON.parse(text) as any;
        live.lastBytes = live.bytes;
        // "Query timed out" or "out of memory" comes as a normal answer with a remark, and only part of the data: not
        // kept as if it were the whole area.
        if (/error|timed out|out of memory/i.test(String(json.remark || ""))) throw new Error(String(json.remark).slice(0, 160));
        return toCell(json.elements || []);
      } catch (err) { lastErr = err; }
    }
  }
  throw lastErr;
}

const kmBetween = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * r), y = b[0] - a[0];
  return Math.hypot(x, y) * 111.2;
};

/** A pause the panel can show ("waiting for a free slot on overpass-api.de: 12 s"). */
async function wait(ms: number, why: string) {
  live.retryAt = Date.now() + ms; live.why = why;
  try { await sleep(ms); } finally { live.retryAt = 0; live.why = ""; }
}

/** On the main Overpass server: waits until one of our slots is free (its status page says in how many seconds), up to
 *  two minutes. True when it waited (so a refused query is worth asking again). */
/** A line's stops being looked up right now (the area downloads hold off meanwhile). */
let lookups = 0;

/** The main server has a slot free for us right now (other servers: always assumed). */
async function slotFree(url: string) {
  if (!url.startsWith("https://overpass-api.de/")) return true;
  try {
    const res = await fetch("https://overpass-api.de/api/status", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) });
    return /[1-9]\d* slots? available now/i.test(await res.text());
  } catch { return false; }
}

async function waitForSlot(url: string) {
  if (!url.startsWith("https://overpass-api.de/")) return false;
  try {
    const res = await fetch("https://overpass-api.de/api/status", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    if (/(\d+) slots? available now/i.test(text) && !/^0 slots/im.test(text)) return false;
    const secs = [...text.matchAll(/in (\d+) seconds?/gi)].map((m) => +m[1]);
    if (!secs.length) return false;
    await wait(Math.min(120, Math.min(...secs) + 1) * 1000, "waiting for a free slot on overpass-api.de");
    return true;
  } catch { return false; }
}

/** What the download is doing right now, for the Layers panel: the area being fetched (since when, from which server,
 *  bytes so far and when the first came: Overpass thinks first, then sends), the pause before the next, and the last. */
const live = {
  id: "" as string, started: 0, server: "", bytes: 0, firstByte: 0, retryAt: 0, why: "", lastBytes: 0,
  nextAt: 0, paused: false, last: null as null | { id: string; bytes: number; stored: number; ms: number; ok: boolean },
};

/** How the download is going, for the panel (polled about once a second while it's open). */
export function linesProgress() {
  const now = Date.now();
  return {
    now: current ? { id: current, secs: Math.round((now - live.started) / 1000), bytes: live.bytes, server: live.server,
      // Speed over the time data has been arriving (before that, the server is still working out the answer).
      speed: live.firstByte && now > live.firstByte + 300 ? Math.round(live.bytes / ((now - live.firstByte) / 1000)) : 0,
      retryIn: live.retryAt > now ? Math.ceil((live.retryAt - now) / 1000) : 0, why: live.why } : null,
    nextIn: !current && live.nextAt > now ? Math.ceil((live.nextAt - now) / 1000) : 0,
    paused: live.paused,
    left: { view: view.length, background: background.length },
    last: live.last,
  };
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
/** The cell being fetched right now, for the grid. */
let current: string | null = null;
/** Cells that just failed: not asked again for 10 minutes. */
const failed = new Map<string, number>();
let busy = false;
const recentlyFailed = (id: string) => Date.now() - (failed.get(id) || 0) < 10 * 60_000;
const todo = (id: string) => !isCached(id) && !recentlyFailed(id);

async function run() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      view = view.filter(todo);
      background = background.filter(todo);
      upgrade = upgrade.filter((id) => !recentlyFailed(id));
      const fg = view.length > 0;
      if (!fg && !background.length && !upgrade.length) break;
      if (!fg) {
        // Background: never while a plan is being made (it asks Overpass too), and a good pause between areas, so the
        // volunteer servers barely notice. Anything someone looks at meanwhile goes first.
        while (working() && !view.length) { live.paused = true; await sleep(5000); }
        live.paused = false;
        if (view.length) continue;
      }
      // The downloads being moved to another folder: wait for that.
      while (moving) await sleep(500);
      // A line's stops being looked up: that goes first (up to half a minute), then the next area.
      for (let t = 0; lookups > 0 && t < 30; t++) await sleep(1000);
      // Taken off its list before fetching: a new view may replace the list meanwhile.
      const id = fg ? view.shift()! : background.length ? background.shift()! : upgrade.shift()!, t0 = Date.now();
      current = id; live.id = id; live.started = t0; live.bytes = 0; live.firstByte = 0; live.lastBytes = 0;
      let stored = 0, ok = true;
      try {
        const cell = await fetchCell(id), json = JSON.stringify(cell);
        fs.mkdirSync(cellsDir(), { recursive: true });
        fs.writeFileSync(file(id), json);
        stored = Buffer.byteLength(json);
      } catch (e) {
        ok = false;
        failed.set(id, Date.now());
        console.error(`Transport lines for cell ${id} failed:`, errMsg(e));
      }
      live.last = { id, bytes: live.lastBytes, stored, ms: Date.now() - t0, ok };
      current = null;
      // Volunteer-run servers: one query at a time, with a pause after each (longer in the background).
      const gap = fg ? 1500 : 6000;
      live.nextAt = Date.now() + gap;
      await sleep(gap);
      live.nextAt = 0;
    }
  } finally { busy = false; }
}

const cellIds = (ids: string[], max: number) => [...new Set(ids.filter((x) => CELL_ID.test(x)))].slice(0, max);

/**
 * Downloads these cells ahead, in the background (the trip's areas; the list replaces the last one, so a changed trip
 * doesn't keep fetching the old one's). `first`: the cells in view, fetched before the rest. Answers how many are ready
 * and how many are still to come.
 */
export function prefetchLines(ids: string[], first: string[] = []) {
  const want = cellIds(ids, 1500), front = new Set(cellIds(first, 400));
  const left = want.filter(todo);
  background = [...left.filter((id) => front.has(id)), ...left.filter((id) => !front.has(id))];
  run();
  const ready = want.filter(isCached).length;
  return { total: want.length, ready, left: background.length + (current && want.includes(current) ? 1 : 0), failed: want.filter((id) => !isCached(id) && recentlyFailed(id)).length };
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
      if (!hit.s && !upgrade.includes(id) && id !== current) upgrade.push(id);
      continue;
    }
    if (recentlyFailed(id)) { cells[id] = { l: [], w: {} }; continue; }
    missing.push(id);
  }
  view = missing.filter((id) => id !== current);
  run();
  return { cells, pending: missing.length };
}

/** For the map's grid: which of these cells are downloaded, being fetched now, waiting, or failed. */
export function cellStatus(ids: string[]) {
  const asked = cellIds(ids, 2000), waiting = new Set([...view, ...background]);
  return {
    done: asked.filter(isCached),
    now: current && asked.includes(current) ? current : null,
    waiting: asked.filter((id) => waiting.has(id) && id !== current),
    failed: asked.filter((id) => !isCached(id) && recentlyFailed(id)),
  };
}

// ---- A line's stops, in order (clicking a line in the map's stop card). -------------------------------------------
export interface RouteStops { id: number; name: string; ref: string; colour?: string; stops: { name: string; lat: number; lng: number }[] }

/**
 * The stops of one route (one direction of a line) in the order it calls at them, with names and where they are: asked
 * of Overpass once (a small query), then kept on disk for 90 days. A stop's halt and platform are one stop.
 */
export async function routeStops(id: number): Promise<RouteStops | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const f = path.join(routesDir(), `${id}.json`);
  try { if (Date.now() - fs.statSync(f).mtimeMs <= MAX_AGE) return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* not yet */ }
  const q = `[out:json][timeout:30]; rel(${id}); out body; node(r); out qt;`;
  // A small query someone is waiting for: it doesn't queue behind the area downloads. While it runs they don't start
  // another area, and when the main server's slots are taken (by those downloads) a backup answers it instead.
  lookups++;
  try {
    const order = (await slotFree(OVERPASS[0])) ? OVERPASS : [...OVERPASS.slice(1), OVERPASS[0]];
    return await askRoute(id, q, f, order);
  } finally { lookups--; }
}

async function askRoute(id: number, q: string, f: string, servers: string[]): Promise<RouteStops | null> {
  let lastErr: unknown;
  for (const url of servers) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(40000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as any;
      const route = (json.elements || []).find((e: any) => e.type === "relation" && e.id === id);
      if (!route) return null;
      const nodes = new Map<number, any>((json.elements || []).filter((e: any) => e.type === "node").map((e: any) => [e.id, e]));
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
      fs.writeFileSync(f, JSON.stringify(out));
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
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
