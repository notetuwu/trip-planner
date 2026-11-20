// Local server: serves the planner UI, manages place lists (CSV files, uploads, Google Maps list imports),
// geocodes via OpenStreetMap Nominatim, and shells out to `claude -p` to build itineraries.
// Run: python start.py   (or: node server.js, then open http://localhost:5173)

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const PORT = Number(process.env.PORT) || 5173;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SAVES_DIR = path.join(ROOT, "saves");
const LISTS_DIR = path.join(ROOT, "lists");
const CACHE_DIR = path.join(ROOT, "cache");
const GEOCODE_CACHE = path.join(CACHE_DIR, "geocode.json");
const TIMEOUT_MS = 25 * 60 * 1000; // research runs can take a while
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Names become file names, so keep them to letters, digits, spaces, - and _.
const cleanName = (name) => String(name || "").trim().replace(/[^\p{L}\p{N}_\- ]+/gu, "").trim().slice(0, 80);

// ---------- CSV ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Accepts Google Takeout "Saved" CSVs (Title, Note, URL, Tags, Comment) and simple name/lat/lng sheets.
function csvToPlaces(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const c = {
    title: col("title", "name"), note: col("note", "notes", "description"), url: col("url", "link"),
    tags: col("tags"), comment: col("comment"), address: col("address"),
    lat: col("lat", "latitude"), lng: col("lng", "lon", "long", "longitude"),
  };
  const get = (r, i) => (i >= 0 ? (r[i] || "").trim() : "");
  const num = (v) => (v === "" || isNaN(+v) ? undefined : +v);
  return rows
    .map((r) => ({
      title: get(r, c.title), note: get(r, c.note), url: get(r, c.url), tags: get(r, c.tags),
      comment: get(r, c.comment), address: get(r, c.address), lat: num(get(r, c.lat)), lng: num(get(r, c.lng)),
    }))
    .filter((p) => p.title);
}

// ---------- Google Maps shared lists ----------
// Uses the undocumented endpoint the list page itself calls (no API key; the list must be shared by link).
// Approach from github.com/ForceGT/gmaps-list-export.

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// A bare UA makes the maps.app.goo.gl redirector answer with a plain 302 instead of a JS page.
const SHORTLINK_UA = "Mozilla/5.0";
// Pre-answered cookie consent, so EU requests are not bounced to consent.google.com.
const CONSENT_COOKIE = ["SOCS", "CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg"];

async function fetchFollow(url, ua, jar) {
  for (let i = 0; i < 10; i++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": ua, Cookie: cookie } });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(";"), eq = kv.indexOf("=");
      if (eq > 0) jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
    return { url, res };
  }
  throw new Error("Too many redirects");
}

async function fetchGoogleList(shareUrl) {
  if (!/^https:\/\/([\w-]+\.)*(google\.[a-z.]+|goo\.gl)\//i.test(shareUrl)) throw new Error("That doesn't look like a Google Maps link.");
  const jar = new Map([CONSENT_COOKIE]);
  let { url: finalUrl } = await fetchFollow(shareUrl, SHORTLINK_UA, jar);
  // If we still landed on the consent page, the real target is in its `continue` parameter.
  const cont = new URL(finalUrl).searchParams.get("continue");
  if (cont) finalUrl = cont;
  const decoded = decodeURIComponent(shareUrl + " " + finalUrl);
  const id = (decoded.match(/\/placelists\/list\/(-?[\w-]+)/) || decoded.match(/!11m\d+!2s(-?[\w-]+)/) || decoded.match(/!2s(-?[\w-]+)/) || [])[1];
  const token = (decoded.match(/[?&]token=([\w-]+)/) || [])[1];
  if (!id) throw new Error("Couldn't find a list in that link. In Google Maps open Saved → your list → Share, and paste that link.");

  const listPage = `https://www.google.com/maps/placelists/list/${id}${token ? `?token=${token}` : ""}`;
  const session = crypto.randomBytes(12).toString("base64url");
  const pb = `!2e2!3e2!4i500!6m3!1s${session}!15i204459!28e2!13s${encodeURIComponent(listPage)}!16b1`;
  const apiUrl = `https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=us&pb=${pb}`;
  const { res } = await fetchFollow(apiUrl, BROWSER_UA, jar);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text.replace(/^\)\]\}'\s*/, "")); }
  catch { throw new Error(`Google didn't return the list (HTTP ${res.status}). Make sure it is shared by link and opens in a private window.`); }
  const root = data?.[0];
  if (!root || !Array.isArray(root[8])) throw new Error("The list came back empty. Is it shared by link?");

  const places = root[8].map((p) => {
    const info = p[1] || [];
    const ll = info[5];
    const title = String(p[2] || info[2] || "").trim();
    const placeId = typeof info[7] === "string" ? info[7] : "";
    return {
      title,
      note: typeof p[3] === "string" ? p[3] : "",
      address: typeof info[4] === "string" ? info[4] : "",
      lat: Array.isArray(ll) && typeof ll[2] === "number" ? ll[2] : undefined,
      lng: Array.isArray(ll) && typeof ll[3] === "number" ? ll[3] : undefined,
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(title)}${placeId ? `&query_place_id=${placeId}` : ""}`,
      tags: "", comment: "",
    };
  }).filter((p) => p.title);
  return { title: typeof root[4] === "string" ? root[4] : "", places };
}

// ---------- Place lists (lists/<name>.json) ----------

const listPath = (name) => { const n = cleanName(name); return n ? path.join(LISTS_DIR, n + ".json") : null; };
const readList = (name) => { const f = listPath(name); return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
function writeList(list) {
  fs.mkdirSync(LISTS_DIR, { recursive: true });
  fs.writeFileSync(listPath(list.name), JSON.stringify(list, null, 1));
  return list;
}

// Keep coordinates we already had when a re-import comes back without them.
function mergeCoords(fresh, old = []) {
  const byTitle = new Map(old.map((p) => [p.title, p]));
  return fresh.map((p) => {
    const o = byTitle.get(p.title);
    return p.lat == null && o?.lat != null ? { ...p, lat: o.lat, lng: o.lng } : p;
  });
}

async function syncList(list) {
  if (list.source?.type === "google") {
    const { title, places } = await fetchGoogleList(list.source.url);
    list.places = mergeCoords(places, list.places);
    list.title = title || list.title;
  } else if (list.source?.type === "csv" && fs.existsSync(list.source.file)) {
    list.places = mergeCoords(csvToPlaces(fs.readFileSync(list.source.file, "utf8")), list.places);
  } else return list;
  list.syncedAt = new Date().toISOString();
  return writeList(list);
}

// CSV files next to server.js (e.g. a Google Takeout export) show up as lists automatically and re-sync when edited.
function adoptCsvFiles() {
  const files = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(ROOT, f));
  if (process.env.PLACES_CSV) files.push(path.resolve(process.env.PLACES_CSV));
  for (const file of files) {
    const name = cleanName(path.basename(file, path.extname(file)));
    if (!name || !fs.existsSync(file) || readList(name)) continue;
    writeList({ name, source: { type: "csv", file }, places: csvToPlaces(fs.readFileSync(file, "utf8")), syncedAt: new Date().toISOString() });
    console.log(`Imported ${path.basename(file)} as place list "${name}"`);
  }
}

function listSummaries() {
  if (!fs.existsSync(LISTS_DIR)) return [];
  return fs.readdirSync(LISTS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    const l = JSON.parse(fs.readFileSync(path.join(LISTS_DIR, f), "utf8"));
    return { name: l.name, title: l.title || "", count: l.places.length, source: l.source, syncedAt: l.syncedAt };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function getList(name) {
  const list = readList(name);
  if (list?.source?.type === "csv" && fs.existsSync(list.source.file) && fs.statSync(list.source.file).mtime > new Date(list.syncedAt)) {
    return syncList(list);
  }
  return list;
}

// ---------- Geocoding (OpenStreetMap Nominatim, max 1 request/second, cached on disk) ----------

let geoCache = {};
try { geoCache = JSON.parse(fs.readFileSync(GEOCODE_CACHE, "utf8")); } catch {}
// Cache v2 added the Photon fallback: retry everything v1 couldn't find.
if (geoCache.__v !== 2) {
  for (const k of Object.keys(geoCache)) if (geoCache[k] === null) delete geoCache[k];
  geoCache.__v = 2;
}
const geoQueue = [];
let geoBusy = false, geoSaveTimer;
// The "near" point (rounded to ~10 km) is part of the key only when given, so older cache entries stay valid.
const geoKey = (q, cc, near) => `${String(q).trim().toLowerCase()}|${cc || ""}${near ? `|${(+near[0]).toFixed(1)},${(+near[1]).toFixed(1)}` : ""}`;

function saveGeoCache() {
  clearTimeout(geoSaveTimer);
  geoSaveTimer = setTimeout(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(geoCache));
  }, 2000);
}

// All Nominatim calls (search and reverse) share one slot per 1.1 s.
let nextSlot = 0;
async function nominatim(endpoint, params) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://nominatim.openstreetmap.org/${endpoint}?${params}`, { headers: { "User-Agent": "local-trip-planner/2.0" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

// Photon (komoot, also OpenStreetMap data) is much better at fuzzy shop/sight names than Nominatim.
async function photon(params) {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { headers: { "User-Agent": "local-trip-planner/2.0" } });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  return (await res.json()).features || [];
}
function photonHit(f) {
  const p = f.properties, [lng, lat] = f.geometry.coordinates;
  const street = p.street && (p.housenumber ? `${p.street} ${p.housenumber}` : p.street);
  const label = [...new Set([p.name, street, p.district || p.locality, p.city || p.county, p.state, p.country].filter(Boolean))].join(", ");
  return { lat, lng, name: p.name || street || "", label, country: p.country || "", cc: (p.countrycode || "").toLowerCase(), kind: p.osm_value || "" };
}
const nominatimHit = (hit) => ({
  lat: +hit.lat, lng: +hit.lon, name: hit.name || hit.display_name.split(",")[0], label: hit.display_name,
  country: hit.address?.country || "", cc: (hit.address?.country_code || "").toLowerCase(), kind: hit.type || "",
});

// `near` ([lat, lng], optional) keeps results around that point, e.g. the town an itinerary stop is in,
// so a "Gasthaus zur Post" is found in the right village rather than anywhere in the country.
async function geocodeOne(q, cc, near) {
  const params = new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1", "accept-language": "en" });
  if (cc) params.set("countrycodes", cc);
  if (near) {
    const [lat, lng] = near, d = 0.6; // roughly 50-65 km around the point
    params.set("viewbox", `${lng - d},${lat + d},${lng + d},${lat - d}`);
    params.set("bounded", "1");
  }
  const [hit] = await nominatim("search", params);
  if (hit) return nominatimHit(hit);
  // Fall back to Photon, also with the name cut before " - ", " | " or "(" (e.g. "Store - Shibuya Main Store").
  const ccs = (cc || "").split(",").filter(Boolean);
  const km = (f) => {
    if (!near) return 0;
    const [lng, lat] = f.geometry.coordinates, r = Math.PI / 180;
    return Math.hypot((lng - near[1]) * Math.cos(lat * r), lat - near[0]) * 111;
  };
  for (const name of new Set([q, q.replace(/\s+[-–|(].*$/, "")])) {
    const pp = new URLSearchParams({ q: name, limit: "5", lang: "en" });
    if (near) { pp.set("lat", near[0]); pp.set("lon", near[1]); }
    const f = (await photon(pp))
      .find((f) => (!ccs.length || ccs.includes((f.properties.countrycode || "").toLowerCase())) && km(f) < 60);
    if (f) return photonHit(f);
  }
  return null;
}

// Name search for the map's search box: Photon biased to the map view, Nominatim as a fallback.
async function searchPlaces(q, lat, lng, cc) {
  const params = new URLSearchParams({ q, limit: "8", lang: "en" });
  if (isFinite(lat) && isFinite(lng)) { params.set("lat", lat); params.set("lon", lng); }
  let hits = [];
  try { hits = (await photon(params)).map(photonHit); } catch (e) { console.error("Photon:", e.message); }
  if (!hits.length) {
    const np = new URLSearchParams({ q, format: "jsonv2", limit: "6", addressdetails: "1", "accept-language": "en" });
    if (cc) np.set("countrycodes", cc);
    hits = (await nominatim("search", np)).map(nominatimHit);
  }
  // Places in the trip's countries first.
  const ccs = (cc || "").split(",").filter(Boolean);
  return hits.sort((a, b) => ccs.includes(b.cc) - ccs.includes(a.cc));
}

async function runGeoQueue() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const { q, cc, near, key } = geoQueue.shift();
    try { geoCache[key] = await geocodeOne(q, cc, near); saveGeoCache(); }
    catch (e) { console.error("Geocode failed:", q, e.message); }
  }
  geoBusy = false;
}

// What is at a clicked map point: the nearest named thing (shop, sight, street…).
// Besides the nearest named thing, returns the broader names for the same spot (neighbourhood, town), because a click
// on "Venice" usually lands on some shop or cash machine; the page picks one by zoom level and offers the others.
async function reverseGeocode(lat, lng) {
  const key = `@2:${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (!(key in geoCache)) {
    const hit = await nominatim("reverse", new URLSearchParams({ lat, lon: lng, format: "jsonv2", zoom: "18", addressdetails: "1", "accept-language": "en" }));
    if (hit && !hit.error) {
      const a = hit.address || {};
      const town = a.city || a.town || a.village || a.municipality || "";
      const area = a.neighbourhood || a.quarter || a.suburb || a.city_district || "";
      const options = [
        hit.name && { name: hit.name, level: "place" },
        area && { name: area, level: "area" },
        town && { name: town, level: "town" },
        !town && a.county && { name: a.county, level: "town" },
      ].filter(Boolean).filter((o, i, all) => all.findIndex((x) => x.name === o.name) === i);
      geoCache[key] = {
        name: hit.name || hit.display_name.split(",")[0], label: hit.display_name, options,
        short: [a.road, area, town, a.country].filter(Boolean).join(", "),
        city: town, cc: (a.country_code || "").toLowerCase(),
      };
    } else geoCache[key] = null;
    saveGeoCache();
  }
  return geoCache[key];
}

function geocodeBatch(queries) {
  const results = {};
  let pending = 0;
  for (const { q, cc, near: n, first } of queries.slice(0, 1000)) {
    const near = Array.isArray(n) && n.length === 2 && n.every(isFinite) ? n.map(Number) : null;
    if (!q || !String(q).trim()) continue;
    const key = geoKey(q, cc, near);
    if (key in geoCache) results[key] = geoCache[key];
    else {
      pending++;
      const queued = geoQueue.findIndex((x) => x.key === key);
      const job = { q: String(q).trim(), cc, near, key, first: !!first };
      // Stays and itinerary stops jump ahead of the (often long) saved-places backlog, but stay in the order they
      // were asked for among themselves (a day's town must be found before the stops searched around it).
      if (first && !geoQueue[queued]?.first) {
        if (queued >= 0) geoQueue.splice(queued, 1);
        const at = geoQueue.findIndex((x) => !x.first);
        geoQueue.splice(at < 0 ? geoQueue.length : at, 0, job);
      } else if (queued < 0) geoQueue.push(job);
    }
  }
  runGeoQueue();
  return { results, pending, queued: geoQueue.length };
}

// ---------- Routing (real roads and paths between stops) ----------
// Walking via the FOSSGIS router, driving via the OSRM demo (FOSSGIS as backup). Both are free public servers that ask
// for at most about one request per second, so each mode has its own queue. Results are cached on disk.

const ROUTE_CACHE = path.join(CACHE_DIR, "routes.json");
let routeCache = {};
try { routeCache = JSON.parse(fs.readFileSync(ROUTE_CACHE, "utf8")); } catch {}
let routeSaveTimer;
function saveRouteCache() {
  clearTimeout(routeSaveTimer);
  routeSaveTimer = setTimeout(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(ROUTE_CACHE, JSON.stringify(routeCache));
  }, 2000);
}
const ROUTERS = {
  foot: ["https://routing.openstreetmap.de/routed-foot/route/v1/foot"],
  car: ["https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"],
};
const routeKey = (mode, a, b) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;
const routeQueues = { foot: [], car: [] }, routeBusy = { foot: false, car: false };

async function fetchRoute(mode, a, b) {
  let lastErr;
  for (const base of ROUTERS[mode]) {
    try {
      const res = await fetch(`${base}/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`, {
        headers: { "User-Agent": "local-trip-planner/2.0" }, signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (j.code === "NoRoute") return null;
      if (!res.ok || j.code !== "Ok") throw new Error(j.message || `HTTP ${res.status}`);
      const r = j.routes[0];
      // Stored as [lat, lng] pairs rounded to ~1 m, with distance (m) and duration (s).
      // Long drives (stay to stay) come back with many thousands of points; thin them to keep the cache small.
      let c = r.geometry.coordinates;
      if (c.length > 1500) { const step = Math.ceil(c.length / 1500); c = c.filter((_, i) => i % step === 0 || i === c.length - 1); }
      return { d: Math.round(r.distance), t: Math.round(r.duration), c: c.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function runRouteQueue(mode) {
  if (routeBusy[mode]) return;
  routeBusy[mode] = true;
  while (routeQueues[mode].length) {
    const { a, b, key } = routeQueues[mode].shift();
    const t0 = Date.now();
    try { routeCache[key] = await fetchRoute(mode, a, b); saveRouteCache(); }
    catch (e) { console.error(`Routing (${mode}) failed:`, e.message); }
    await sleep(Math.max(0, 1050 - (Date.now() - t0)));
  }
  routeBusy[mode] = false;
}

// legs: [{ mode: "foot"|"car", from: [lat, lng], to: [lat, lng] }] -> { routes: { key: route|null }, pending }
function routeBatch(legs) {
  const routes = {};
  let pending = 0;
  for (const { mode, from, to } of legs.slice(0, 600)) {
    if (!ROUTERS[mode] || !Array.isArray(from) || !Array.isArray(to) || ![...from, ...to].every((n) => isFinite(n))) continue;
    const key = routeKey(mode, from.map(Number), to.map(Number));
    if (key in routeCache) routes[key] = routeCache[key];
    else {
      pending++;
      if (!routeQueues[mode].some((x) => x.key === key)) routeQueues[mode].push({ a: from.map(Number), b: to.map(Number), key });
    }
  }
  runRouteQueue("foot"); runRouteQueue("car");
  return { routes, pending };
}

// ---------- Claude CLI ----------

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
    const exe = out.find((p) => /\.exe$/i.test(p)) || out[0];
    if (exe) return exe;
  } catch {}
  // Fall back to the binary bundled with the VS Code extension (newest version wins).
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const bin = process.platform === "win32" ? "claude.exe" : "claude";
    const candidates = fs.readdirSync(extDir)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(extDir, d, "resources", "native-binary", bin))
      .filter((p) => fs.existsSync(p));
    if (candidates[0]) return candidates[0];
  } catch {}
  return null;
}

const ITINERARY_SCHEMA = {
  type: "object",
  required: ["summary", "destination", "days", "totalEstimatedCost"],
  properties: {
    summary: { type: "string", description: "2-4 sentence overview of the trip. Not the planning notes." },
    destination: { type: "string", description: "Country / countries of the trip, e.g. 'Japan' or 'Portugal & Spain'" },
    localCurrency: { type: "string", description: "ISO code of the local currency, e.g. JPY" },
    totalEstimatedCost: { type: "number" },
    days: {
      type: "array",
      items: {
        type: "object",
        required: ["date", "city", "title", "items", "estimatedCost"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          city: { type: "string" },
          title: { type: "string" },
          estimatedCost: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["time", "place", "description"],
              properties: {
                time: { type: "string", description: "e.g. 09:30" },
                place: { type: "string", description: "Exact Title from the list when fromList is true" },
                fromList: { type: "boolean" },
                description: { type: "string" },
                cost: { type: "number" },
                transport: { type: "string", description: "How to get here from the previous stop" },
                lat: { type: "number", description: "Latitude of the place, best estimate" },
                lng: { type: "number", description: "Longitude of the place, best estimate" },
                group: { type: "string", description: "Only while the travelers split up: short label of the subgroup doing this, e.g. 'Group A'. Omit when everyone is together." },
                people: { type: "number", description: "How many travelers are in that subgroup. Omit when everyone is together." },
              },
            },
          },
          notes: { type: "string" },
        },
      },
    },
    unused: {
      type: "array",
      items: {
        type: "object",
        properties: { place: { type: "string" }, reason: { type: "string" } },
      },
    },
    tips: { type: "array", items: { type: "string" } },
    holidaysAndEvents: {
      type: "array",
      description: "Public holidays, festivals, events and seasonal happenings during the trip",
      items: {
        type: "object",
        required: ["date", "name", "impact"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, or a range like 2026-09-19..2026-10-04" },
          name: { type: "string" },
          where: { type: "string" },
          impact: { type: "string", description: "What it means for the plan (closures, crowds, transit, worth seeing)" },
        },
      },
    },
    sources: { type: "array", items: { type: "string" }, description: "URLs relied on (only when researching online)" },
  },
};

// ---------- Public holidays (date.nager.at, free, no key) ----------

const holidayCache = new Map();
async function tripHolidays(trip) {
  const starts = trip.stays.map((s) => s.start).filter(Boolean).sort();
  if (!starts.length) return [];
  const first = starts[0];
  const lastStay = trip.stays.filter((s) => s.start).sort((a, b) => a.start.localeCompare(b.start)).at(-1);
  const end = new Date(new Date(lastStay.start + "T00:00:00Z").getTime() + (Number(lastStay.nights) || 0) * 864e5).toISOString().slice(0, 10);
  const ccs = [...new Set(trip.stays.map((s) => String(s.cc || "").toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  const years = [...new Set([first.slice(0, 4), end.slice(0, 4)])];
  const out = [];
  await Promise.allSettled(ccs.flatMap((cc) => years.map(async (y) => {
    const key = `${y}/${cc}`;
    if (!holidayCache.has(key)) {
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${key}`, { signal: AbortSignal.timeout(5000) });
      holidayCache.set(key, res.ok ? await res.json() : []);
    }
    for (const h of holidayCache.get(key)) if (h.date >= first && h.date <= end) out.push({ ...h, cc });
  })));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Real places near each stay (OpenStreetMap via Overpass) ----------
// Handed to the model so it plans with places that exist (and have exact coordinates) instead of inventing names.

const NEARBY_CACHE = path.join(CACHE_DIR, "nearby.json");
let nearbyCache = {};
try { nearbyCache = JSON.parse(fs.readFileSync(NEARBY_CACHE, "utf8")); } catch {}
// Public Overpass servers, most reliable first. They're volunteer-run: a city can take 30 s, and the main one
// allows only two parallel queries per visitor (hence at most 2 towns at a time below).
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function locateTown(q, cc) {
  const key = geoKey(q, cc);
  if (!(key in geoCache)) { geoCache[key] = await geocodeOne(q, cc); saveGeoCache(); }
  return geoCache[key];
}

async function overpassAround(lat, lng) {
  // Sights and food are capped separately, so a big city's hundreds of restaurants can't crowd out its sights.
  const q = `[out:json][timeout:55];
    nwr(around:2500,${lat},${lng})["amenity"~"^(restaurant|cafe|biergarten|ice_cream|fast_food|bar|pub)$"]["name"]->.food;
    (nwr(around:7000,${lat},${lng})["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["name"];
     nwr(around:7000,${lat},${lng})["historic"~"^(castle|monument|ruins|fort|palace|church|city_gate|archaeological_site)$"]["name"];)->.sights;
    .sights out center tags 400;
    .food out center tags 300;`;
  // Two rounds over all servers: busy servers often answer a little later.
  let lastErr;
  for (let round = 0; round < 2; round++) {
    if (round) await sleep(10000);
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), headers: { "User-Agent": "local-trip-planner/2.0" }, signal: AbortSignal.timeout(65000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()).elements || [];
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}

// Picks the most useful places: well-known sights first; for food, places matching the travelers' diet if they mention one.
function rankNearby(elements, interests) {
  const diet = /vegan/i.test(interests) ? "diet:vegan" : /vegetarian/i.test(interests) ? "diet:vegetarian" : null;
  const gf = /gluten/i.test(interests);
  const seen = new Set(), sights = [], food = [];
  for (const e of elements) {
    const t = e.tags || {}, c = e.center || e;
    if (!t.name || c.lat == null || seen.has(t.name)) continue;
    seen.add(t.name);
    const kind = t.amenity || t.tourism || t.historic || t.leisure;
    const isFood = ["restaurant", "cafe", "biergarten", "ice_cream", "fast_food", "bar", "pub"].includes(t.amenity);
    const extras = [
      t.cuisine && t.cuisine.replace(/;/g, ", "),
      diet && /yes|only/.test(t[diet] || "") && (t[diet] === "only" ? "fully vegan/vegetarian" : "vegan/vegetarian options"),
      gf && /yes|only/.test(t["diet:gluten_free"] || "") && "gluten-free options",
    ].filter(Boolean);
    let score = (t.wikidata || t.wikipedia ? 4 : 0) + (t.website ? 1 : 0) + (t.opening_hours ? 1 : 0);
    if (isFood) score += (t.amenity === "restaurant" || t.amenity === "cafe" ? 1 : 0) + (extras.some((x) => /options|fully/.test(x)) ? 5 : 0);
    else score += ["museum", "castle", "palace", "attraction", "zoo", "aquarium"].includes(kind) ? 2 : 0;
    (isFood ? food : sights).push({ name: t.name, kind: kind.replace(/_/g, " "), extras, lat: +c.lat.toFixed(5), lng: +(c.lon ?? c.lng).toFixed(5), score });
  }
  const top = (arr, n) => arr.sort((a, b) => b.score - a.score).slice(0, n).map(({ score, ...p }) => p);
  return { sights: top(sights, 30), food: top(food, 30) };
}

// The raw OpenStreetMap places around a town: cached on disk for 30 days, and fetched only once even when the
// background warm-up and a generation ask at the same time.
const nearbyInflight = new Map();
async function nearbyElements(city, cc, onStatus = () => {}) {
  const town = await locateTown(city, cc);
  if (!town) return null;
  const key = `${town.lat.toFixed(3)},${town.lng.toFixed(3)}`;
  const hit = nearbyCache[key];
  if (hit && Date.now() - hit.at < 30 * 864e5) return hit.elements;
  onStatus(`Finding real places around ${city}…`);
  if (!nearbyInflight.has(key)) {
    nearbyInflight.set(key, overpassAround(town.lat, town.lng).then((els) => {
      const elements = els.map(({ lat, lon, center, tags }) => ({ lat, lon, center, tags }));
      nearbyCache[key] = { at: Date.now(), elements };
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(NEARBY_CACHE, JSON.stringify(nearbyCache));
      return elements;
    }).finally(() => nearbyInflight.delete(key)));
  }
  return nearbyInflight.get(key);
}

// Runs fn over items, at most `limit` at a time (Overpass allows a couple of parallel queries per server).
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

// For each stay: { city, sights, food }.
async function nearbyPlaces(trip, onStatus) {
  const interests = `${trip.interests || ""} ${trip.notes || ""}`;
  const stays = trip.stays.filter((s) => s.city);
  // Don't hold up planning forever: after ~100 s a town is planned without its list (the fetch carries on and is cached for next time).
  const deadline = Date.now() + 100000;
  const lists = await pool(stays, 2, async (s) => {
    try {
      const fetching = nearbyElements(s.city, s.cc, onStatus);
      fetching.catch((e) => console.error(`Nearby places for ${s.city} failed:`, e.message));
      const elements = await Promise.race([fetching, sleep(Math.max(0, deadline - Date.now())).then(() => "timeout")]);
      if (elements === "timeout") { console.log(`Nearby places for ${s.city} are taking long; planning without them for now.`); return null; }
      return elements ? { city: s.city, ...rankNearby(elements, interests) } : null;
    } catch { return null; }
  });
  return lists.filter(Boolean);
}

// How many stops a day should have at each pace (meals come on top).
const STOPS_PER_DAY = { relaxed: "3-4", balanced: "4-6", packed: "6-8" };
const MODE_TEXT = { car: "by car (they drive themselves)", train: "by train", bus: "by bus or coach", flight: "by plane", ferry: "by ferry", bike: "by bike" };

function buildPrompt(trip, places, { local = false } = {}) {
  const research = !local && trip.research;
  const placeLines = places
    .map((p) => {
      const extra = [p.note, p.tags, p.comment, p.address].filter(Boolean).join(" | ");
      const who = trip.mustSeeWho?.[p.title];
      const flag = trip.mustSee?.includes(p.title)
        ? (who && who < trip.travelers ? ` [MUST SEE for ${who} of ${trip.travelers} travelers]` : " [MUST SEE]")
        : trip.skip?.includes(p.title) ? " [SKIP]" : "";
      // Coordinates go in a separate tag (not the brackets) so models don't copy them into the place name.
      const at = typeof p.lat === "number" ? ` {location ${p.lat.toFixed(4)},${p.lng.toFixed(4)}}` : "";
      // Places picked on the map get their address so the model knows where they are, even if the name is just a shop.
      const picked = p.picked ? " {picked on the map}" : "";
      return `- ${p.title}${extra ? ` (${extra})` : ""}${at}${picked}${flag}`;
    })
    .join("\n");

  // Spell out each stay's travel days and full days, so day trips land on days without a transfer.
  const addDays = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);
  const stays = trip.stays
    .map((s, i) => {
      const nights = Number(s.nights) || 0;
      const full = s.start ? Array.from({ length: Math.max(0, nights - 1) }, (_, k) => addDays(s.start, k + 1)) : [];
      const days = !s.start ? "" : nights === 0
        ? " (passing through, no overnight stay)"
        : `; travel days: ${s.start} (arrival) and ${addDays(s.start, nights)} (departure); full days: ${full.length ? full.join(", ") : "none"}`;
      const prev = trip.stays[i - 1];
      const travel = prev && MODE_TEXT[s.travel] ? `\n   Getting here from ${prev.city}: ${MODE_TEXT[s.travel]} (chosen by the travelers)` : "";
      const trips = (s.dayTrips || []).filter((t) => t.place)
        .map((t) => `\n   Planned day trip: ${t.place}${MODE_TEXT[t.mode] ? `, ${MODE_TEXT[t.mode]} there and back (chosen by the travelers)` : ""}, on one of the full days`).join("");
      return `${i + 1}. ${s.city}${s.country ? ` (${s.country})` : ""}: arrive ${s.start}, ${nights} night(s)${s.hotel ? `, staying at/near ${s.hotel}` : ""}${days}${travel}${trips}`;
    })
    .join("\n");
  const chosenModes = trip.stays.some((s, i) => (i && MODE_TEXT[s.travel]) || (s.dayTrips || []).some((t) => t.place && MODE_TEXT[t.mode]));
  const holidays = (trip.holidays || [])
    .map((h) => `- ${h.date} ${h.cc}: ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}${h.counties?.length ? ` - regional only: ${h.counties.join(", ")}` : " - nationwide"}`)
    .join("\n");
  const pace = Object.keys(STOPS_PER_DAY).find((k) => String(trip.pace).startsWith(k)) || "balanced";
  const poiLine = (p) => `- ${p.name} (${[p.kind, ...p.extras].join("; ")}) {location ${p.lat},${p.lng}}`;
  const nearby = (trip.nearby || []).filter((n) => n.sights.length || n.food.length)
    .map((n) => `### ${n.city}\nSights:\n${n.sights.map(poiLine).join("\n") || "(none found)"}\nFood and drink:\n${n.food.map(poiLine).join("\n") || "(none found)"}`)
    .join("\n\n");

  let prompt = `You are an expert local travel planner building a detailed, realistic day-by-day itinerary. Work out the destination country or countries from the stays and the saved places.

${research
  ? `Research online while you plan, using web search and web fetch: opening hours and closing days on the actual dates, current ticket prices, festivals and events during the trip, transport options, times and prices between the cities, and anything else that is date-dependent or uncertain. Prefer official websites. Focus on the must-sees, day trips and transfers rather than looking up every café; about 10-25 searches is plenty. Where you could not verify something, say so in the item's description.`
  : `Use your own knowledge of the destination (geography, opening days, holidays, transit, typical prices, local customs).${local ? "" : " Do not use tools; just answer."}`}

${local
  ? `If you think before answering, keep it brief (a few short paragraphs): most of your effort belongs in the itinerary itself. Answer with one JSON object only, matching the schema at the end. Start with "planningNotes": notes for the travelers`
  : `${research ? "When your research is done, and right before" : "Before"} returning the itinerary, write your planning notes as plain text in your reply (not inside the itinerary; its "summary" is just a 2-4 sentence overview) for the travelers`} (they can expand them to see how you approached the plan): how you split the days between cities and day trips, where the must-sees went and why, what the holidays and events mean for the plan, budget trade-offs, and anything you had to compromise on or leave out. Use short paragraphs or "- " bullets (one bullet per line), under 250 words.${local ? "" : " Then return the itinerary."}

## Stays (in order)
${stays}

## Constraints
- Daily budget: ${trip.dailyBudget} ${trip.currency} per day for ${trip.travelers} traveler(s), covering activities, food and local transport (accommodation is already paid, intercity transfers count toward the day they happen). It is a ceiling, not a target.
- Pace: ${trip.pace}
- Interests / preferences: ${trip.interests || "none given"}
- Extra notes: ${trip.notes || "none"}
${trip.researchNotes ? `
## Web research findings (gathered online just now; trust these over your own memory)
${trip.researchNotes}
` : ""}${holidays ? `
## Public holidays during the trip (official list from date.nager.at)
Plan around these: closed shops and museums, changed transit timetables, crowds, and celebrations worth seeing. Regional holidays only apply in the listed states/cantons.
${holidays}
` : ""}
## Saved places
${places.length ? `Build the itinerary primarily from these. Places marked [MUST SEE] must be included. Never schedule [SKIP] places. Hotels in the list are accommodation candidates, not activities. Day trips from a base city are fine if reasonable. Add meals and a few unlisted highlights to fill the days; set fromList=false for those.
Places marked "[MUST SEE for N of M travelers]" only interest part of the group. You may split the group up for those: the N go there while the others do something else (ideally another place only they want, so split places pair up). Batch split places into as few split sessions as is sensible and bring everyone back together afterwards. While split, give every item a "group" label (e.g. "Group A", "Group B") and "people" count, and list each subgroup's items in time order; items done together have no group. You can also skip splitting and take everyone if that is clearly simpler.
${placeLines}` : "No saved places; choose the best things to do yourself (fromList=false)."}
${nearby ? `
## Real places around each stay (from OpenStreetMap)
These exist, with exact locations. Use them for sights and especially for meals, writing the name exactly as listed and copying its location into "lat"/"lng". Sights are within about 8 km, food within about 2.5 km of where you sleep. Each list belongs to its stay: only use a place on days spent at that stay (or passing right by it), never on a day in another city, even if the name sounds generic.
${nearby}
` : ""}
## What every day must look like
- Only real places: every named stop must exist under exactly that name (from the saved places, the lists above, or your research). Never make up names for restaurants, cafés or sights. If you don't know a real place for a meal, write a generic stop such as "Lunch around the Marktplatz" instead of inventing one.
- ${STOPS_PER_DAY[pace]} sights or activities per full day, plus meals: a specific, named place for lunch and for dinner (and breakfast when not at the hotel) that fits the interests and dietary needs. Arrival and departure days can be lighter, but still plan the hours that are free.
- "time": the start time in 24-hour "HH:MM" only, nothing else. Items in chronological order with realistic durations, travel time between them and opening hours respected.
- "transport": how to get there from the previous stop, with mode or line and minutes, e.g. "Tram 1 from Hauptbahnhof, 12 min" or "Walk, 5 min".
- "cost": on every item, for the whole group (0 if free): tickets, meals, fares. The day's "estimatedCost" is the sum of its item costs. Don't pad days to reach the budget.
- "description": what to do there and why it's worth it, with practical details (opening hours, whether to book ahead, best time to go, what to order).
- "notes" on the day: anything that affects it, such as holidays, closures (e.g. museums closed on Mondays), markets, festivals, weather and season, bookings to make ahead, or the day going over budget.
- On travel days between cities, the transfer is its own item with departure time, duration, operator or route and price. Name it "<from> → <to> (<mode>)", e.g. "Padua → Milan (car)". Plan around check-out (about 10:00) and check-in (about 15:00).${chosenModes ? `
- Where the stays above say how the travelers get somewhere ("chosen by the travelers"), use exactly that mode; don't swap it for another. By car: the route and main roads, driving time, distance, tolls or vignettes, fuel and parking costs, and a worthwhile stop on the way if there is one. By train or bus: a real connection with operator, departure time, duration and fare, and whether to book ahead. Day trips with a chosen mode are their own outbound and return items ("Milan → Rome (train)", later "Rome → Milan (train)").` : ""}
- Day trips and other long excursions (anything more than about 30-45 minutes away from where you sleep) go on full days only, never on a travel day: changing cities and doing a day trip on the same day is exhausting. Travel days get the transfer plus light sightseeing near the hotel or a stop on the way that lies directly on the route. For example, with 2 nights in Padua the one full day there is the day for Venice. If a must-see day trip fits no full day, say so in the notes (or list it in "unused") rather than squeezing it into a travel day.

## Trip-wide extras
- "holidaysAndEvents": every public holiday, festival, major event or seasonal highlight in the visited places during the trip, with what it means for the plan.
- "tips": 6-10 specific, practical tips for this trip: money and payment, transport passes or tickets worth buying (with prices), reservations to make and how far ahead, etiquette, SIM/data, luggage, tipping.
- "unused": saved places you could not fit, with a short reason.${research ? `
- "sources": the URLs you relied on most.` : ""}

## Output rules
- "destination": the country or countries of the trip. "localCurrency": the local currency's ISO code.
- One entry in "days" for every calendar day from the first arrival to the final departure day, with dates in YYYY-MM-DD.
- "place" is only the place's name. For items from the list it must be the exact Title as written above, without the details in brackets or braces.
- Give every item "lat"/"lng" coordinates (4 decimals) so it can be shown on a map.
- All costs in ${trip.currency}.
- Group nearby places on the same day to minimise transit.
- If the group splits for part of a day (including splits mentioned in the notes), use "group"/"people" on those items as described above.`;

  if (trip.revise?.itinerary && trip.revise?.request) {
    prompt += `

## Current itinerary
${JSON.stringify(trip.revise.itinerary)}

## Requested changes
${trip.revise.request}

Apply the requested changes to the current itinerary and return the complete updated itinerary. Keep everything the request doesn't touch as it is. Your planning notes should explain what you changed and why.`;
  }
  // Servers without schema enforcement only have the prompt to go on.
  if (local) prompt += `\n\n## JSON schema\n${JSON.stringify(LOCAL_SCHEMA)}`;
  return prompt;
}

// Reports generated tokens to the browser, at most ~5 times a second (forced for exact counts).
function tokenMeter(onEvent, estimated) {
  let last = 0;
  return (count, { force = false, perSec } = {}) => {
    const now = Date.now();
    if (!force && now - last < 200) return;
    last = now;
    onEvent({ type: "tokens", count: Math.round(count), estimated, ...(perSec ? { perSec } : {}) });
  };
}

// Runs `claude -p` with streaming output. onEvent receives live progress:
//   { type: "thinking", tokens }  - the CLI only reports how much it is thinking, not the thinking itself
//   { type: "text", text }        - Claude's planning notes, written before the itinerary
//   { type: "progress", days }    - days of the itinerary written so far
// `abort` (an AbortSignal) stops the run, e.g. when the browser goes away.
function runClaude(trip, places, onEvent = () => {}, abort) {
  return new Promise((resolve, reject) => {
    const bin = findClaude();
    if (!bin) return reject(new Error("Could not find the claude CLI. Set CLAUDE_BIN to its path."));

    // With research on, Claude may search and read web pages (and nothing else); both are pre-approved since nobody can answer a prompt.
    const tools = trip.research ? ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"] : ["--tools", ""];
    const args = [
      "-p",
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--json-schema", JSON.stringify(ITINERARY_SCHEMA),
      ...tools,
      "--no-session-persistence",
    ];
    if (trip.model && trip.model !== "default") args.push("--model", trip.model);

    // Drop any API key so the CLI always uses the claude.ai subscription login, never pay-per-token API billing.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env });
    let buf = "", stderr = "", reasoning = "", json = "", days = 0, thinking = 0, result = null;
    let blocks = {}; // content blocks of the current message, by index: { name, input }
    const toolNames = {}; // tool_use id -> tool name, to label the results
    // Output tokens: exact for finished messages; for the one being written, estimated from the
    // CLI's thinking-token updates plus written characters / 4.
    let doneTokens = 0, msgThink = 0, msgChars = 0;
    const meter = tokenMeter(onEvent, true);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude timed out")); }, TIMEOUT_MS);
    abort?.addEventListener("abort", () => { child.kill(); reject(new Error("Cancelled")); });

    const handle = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "result") { result = ev; return; }
      // Tool results (search results, fetched pages) are handed back to Claude as user messages: show them too.
      if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content) {
          if (c.type !== "tool_result") continue;
          const name = toolNames[c.tool_use_id] || "tool";
          if (name === "StructuredOutput") continue;
          const text = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("\n");
          onEvent({ type: "prompt", label: `Result of ${name}`, text });
        }
        return;
      }
      if (ev.type === "system" && ev.subtype === "thinking_tokens") {
        thinking += ev.estimated_tokens_delta || 0;
        msgThink += ev.estimated_tokens_delta || 0;
        meter(doneTokens + msgThink + msgChars / 4);
        return onEvent({ type: "thinking", tokens: thinking });
      }
      const se = ev.type === "stream_event" ? ev.event : null;
      if (se?.type === "message_start") { blocks = {}; msgThink = msgChars = 0; }
      if (se?.type === "message_delta" && se.usage?.output_tokens) {
        doneTokens += se.usage.output_tokens; msgThink = msgChars = 0;
        meter(doneTokens, { force: true });
      }
      if (se?.type === "content_block_delta") {
        msgChars += (se.delta.text || se.delta.partial_json || "").length;
        meter(doneTokens + msgThink + msgChars / 4);
      }
      if (se?.type === "content_block_start" && se.content_block?.type === "tool_use") {
        blocks[se.index] = { name: se.content_block.name, input: "" };
        toolNames[se.content_block.id] = se.content_block.name;
      }
      if (se?.type === "content_block_stop" && blocks[se.index]) {
        // A finished web search or page fetch: tell the browser what Claude looked up.
        const b = blocks[se.index];
        let input = {};
        try { input = JSON.parse(b.input || "{}"); } catch {}
        if (b.name === "WebSearch" && input.query) onEvent({ type: "search", query: input.query });
        if (b.name === "WebFetch" && input.url) onEvent({ type: "fetch", url: input.url });
      }
      const d = se?.type === "content_block_delta" ? se.delta : null;
      if (d?.type === "text_delta") { reasoning += d.text; onEvent({ type: "text", text: d.text }); }
      if (d?.type === "input_json_delta" && blocks[se.index]) {
        blocks[se.index].input += d.partial_json;
        if (blocks[se.index].name !== "StructuredOutput") return;
        // The itinerary arrives as streamed JSON; each "date" key is the start of another day.
        json += d.partial_json;
        const n = (json.match(/"date"\s*:/g) || []).length;
        if (n !== days) { days = n; onEvent({ type: "progress", days }); }
      }
    };
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) handle(buf);
      if (!result) return reject(new Error(`claude exited ${code}: ${stderr || "no result"}`.slice(0, 2000)));
      if (result.is_error) return reject(new Error(result.result || "Claude returned an error"));
      let itinerary = result.structured_output;
      if (!itinerary && typeof result.result === "string") {
        const m = result.result.match(/\{[\s\S]*\}/);
        try { itinerary = m && JSON.parse(m[0]); } catch {}
      }
      if (!itinerary) return reject(new Error("Claude did not return an itinerary:\n" + String(result.result).slice(0, 2000)));
      // The model that wrote the most is the one that planned (Claude Code also uses a small model for side tasks).
      const [model, usage] = Object.entries(result.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0] || ["Claude", {}];
      resolve({
        itinerary, reasoning: reasoning.trim(), costUsd: result.total_cost_usd, durationMs: result.duration_ms,
        engine: `${model} via Claude Code`, tokens: usage.outputTokens || doneTokens,
      });
    });

    const prompt = buildPrompt(trip, places);
    onEvent({
      type: "prompt", label: "Prompt",
      info: `Sent to the Claude Code CLI (claude -p) · model: ${trip.model && trip.model !== "default" ? trip.model : "CLI default"} · tools: ${trip.research ? "WebSearch, WebFetch" : "none"} · `
        + "the itinerary comes back through a StructuredOutput tool forced to the itinerary JSON schema. Claude Code also adds its own system prompt, which isn't visible here.",
      text: prompt,
    });
    child.stdin.end(prompt);
  });
}

// ---------- Local models (Ollama, LM Studio, llama.cpp, Jan, vLLM…) ----------
// Detected by probing their default ports; more can be added with LOCAL_LLM_URLS (comma-separated base URLs).

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// OpenAI-compatible servers on their default ports.
const OPENAI_COMPAT = [
  ["LM Studio", "http://127.0.0.1:1234"], ["llama.cpp / LocalAI", "http://127.0.0.1:8080"],
  ["Jan", "http://127.0.0.1:1337"], ["vLLM", "http://127.0.0.1:8000"], ["KoboldCpp", "http://127.0.0.1:5001"],
  ["text-generation-webui", "http://127.0.0.1:5000"], ["GPT4All", "http://127.0.0.1:4891"],
  ...(process.env.LOCAL_LLM_URLS || "").split(",").map((u) => u.trim()).filter(Boolean).map((u) => [new URL(u).host, u.replace(/\/+$/, "")]),
];

async function getJson(url, ms = 800) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Model ids for local models look like "local|ollama|<base>|<model>" or "local|openai|<base>|<model>".
async function detectLocalModels() {
  const found = [];
  const probes = [
    getJson(`${OLLAMA_URL}/api/tags`).then((d) => {
      for (const m of d.models || []) found.push({ id: `local|ollama|${OLLAMA_URL}|${m.name}`, name: m.name, server: "Ollama", size: m.size });
    }),
    ...OPENAI_COMPAT.map(([server, base]) => getJson(`${base}/v1/models`).then((d) => {
      if (!Array.isArray(d?.data)) return;
      for (const m of d.data) if (m.id && !/embed/i.test(m.id)) found.push({ id: `local|openai|${base}|${m.id}`, name: m.id, server });
    })),
  ];
  await Promise.allSettled(probes);
  return found;
}

// Local models can't write free text before a JSON answer, so their planning notes go in a field (first, so they stream first).
const LOCAL_SCHEMA = {
  ...ITINERARY_SCHEMA,
  required: ["planningNotes", ...ITINERARY_SCHEMA.required],
  properties: {
    planningNotes: { type: "string", description: "Your planning notes for the travelers, under 250 words" },
    ...ITINERARY_SCHEMA.properties,
  },
};

// Small models sometimes leave fields out; fill the gaps so the page can render what they did produce.
function normalizeItinerary(it, travelers = 1) {
  if (!it || !Array.isArray(it.days) || !it.days.length) return null;
  for (const d of it.days) {
    d.items = Array.isArray(d.items) ? d.items.filter((x) => x && x.place) : [];
    for (const x of d.items) {
      x.time = String(x.time ?? "").trim(); x.description = String(x.description ?? "");
      // Some models write a sentence in the time field; keep it as description text instead.
      if (x.time && !/^\d{1,2}:\d{2}/.test(x.time)) { x.description = `${x.time}. ${x.description}`.trim(); x.time = ""; }
      x.place = String(x.place).replace(/\s*[({]\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*[)}]\s*$/, ""); // drop copied "(lat, lng)"
      // "All" / everyone in the group isn't a split.
      if (!x.group || /^(all|everyone|everybody|together|whole group|both|group)$/i.test(String(x.group).trim()) || (travelers > 1 && x.people >= travelers)) {
        delete x.group; delete x.people;
      }
    }
    d.estimatedCost = Number(d.estimatedCost) || d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
    d.city = String(d.city ?? ""); d.title = String(d.title ?? d.city); d.date = String(d.date ?? "");
  }
  it.totalEstimatedCost = Number(it.totalEstimatedCost) || it.days.reduce((n, d) => n + d.estimatedCost, 0);
  it.summary = String(it.summary ?? "");
  return it;
}

// Pull the (possibly still incomplete) planningNotes string out of streamed JSON.
function partialNotes(json) {
  const m = json.match(/"planningNotes"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`); } catch { return null; }
}

// The JSON object in a reply, also when wrapped in a ``` fence or surrounded by chatter.
function parseJsonLoose(text) {
  const s = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
}

// Reads a streaming HTTP body line by line.
async function* lines(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) yield buf;
}

// ---------- Web research for local models ----------
// Local models can't browse, so the planner does it for them: the model calls web_search / fetch_page as tools,
// the server runs them (DuckDuckGo's HTML search, plain page fetches) and hands back the results.

const RESEARCH_TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web. Returns result titles, URLs and snippets.", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "fetch_page", description: "Read a web page as plain text (first few thousand characters).", parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } },
];
const MAX_LOOKUPS = Number(process.env.RESEARCH_MAX_LOOKUPS) || 30;
// One fixed context size for the whole research conversation (changing it makes Ollama reload the model).
// It holds every search result and page the model reads, at most ~1k tokens each.
const RESEARCH_CTX = Math.min(Number(process.env.OLLAMA_NUM_CTX) || 65536, Math.ceil((MAX_LOOKUPS * 1100 + 8000) / 4096) * 4096);
const htmlText = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// Search backends, tried in order. Brave and SearXNG need setting up but are reliable; DuckDuckGo needs nothing but
// starts showing a bot check after many quick searches; Wikivoyage/Wikipedia always work but only know articles.
const SEARCH_BACKENDS = [
  {
    name: "Brave Search", enabled: () => !!process.env.BRAVE_API_KEY,
    async search(q) {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "6" })}`, {
        headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).web?.results || []).map((r) => ({ title: htmlText(r.title || ""), url: r.url, snippet: htmlText(r.description || "") }));
    },
  },
  {
    name: "SearXNG", enabled: () => !!process.env.SEARXNG_URL,
    async search(q) {
      const res = await fetch(`${process.env.SEARXNG_URL.replace(/\/+$/, "")}/search?${new URLSearchParams({ q, format: "json" })}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()).results || []).slice(0, 6).map((r) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
    },
  },
  {
    name: "DuckDuckGo", enabled: () => Date.now() > ddgBlockedUntil,
    async search(q) {
      // Space searches out; rapid-fire queries trigger the bot check sooner.
      const wait = ddgLast + 2500 - Date.now();
      if (wait > 0) await sleep(wait);
      ddgLast = Date.now();
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST", body: new URLSearchParams({ q }), signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/x-www-form-urlencoded" },
      });
      const html = await res.text();
      if (res.status === 202 || /anomaly-modal|challenge-form/.test(html)) {
        ddgBlockedUntil = Date.now() + 15 * 60e3;
        console.log("DuckDuckGo is showing its bot check; skipping it for 15 minutes.");
        throw new Error("bot check");
      }
      const results = [];
      const re = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      for (let m; (m = re.exec(html)) && results.length < 6;) {
        let url = m[1].replace(/&amp;/g, "&");
        const redirect = url.match(/[?&]uddg=([^&]+)/); // DuckDuckGo sometimes wraps links in a redirect
        if (redirect) url = decodeURIComponent(redirect[1]);
        if (url.startsWith("//")) url = "https:" + url;
        results.push({ title: htmlText(m[2]), url, snippet: htmlText(m[3]) });
      }
      return results;
    },
  },
  {
    name: "Wikivoyage + Wikipedia", enabled: () => true,
    async search(q) {
      // Wiki search matches article text, so drop words like "opening hours 2026" that articles rarely contain.
      const simple = q.replace(/\b(opening|hours|times?|tickets?|prices?|cost|202\d|official|website|how to get|from|to)\b/gi, " ").replace(/\s+/g, " ").trim() || q;
      const wiki = async (site, query) => {
        const res = await fetch(`https://${site}/w/api.php?${new URLSearchParams({ action: "query", list: "search", srsearch: query, format: "json", srlimit: "3" })}`, {
          headers: { "User-Agent": "local-trip-planner/2.0" }, signal: AbortSignal.timeout(15000),
        });
        return ((await res.json()).query?.search || []).map((r) => ({
          title: `${r.title} (${site.split(".")[1]})`, url: `https://${site}/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`, snippet: htmlText(r.snippet || ""),
        }));
      };
      const [voy, wp] = await Promise.all([wiki("en.wikivoyage.org", simple), wiki("en.wikipedia.org", simple)]);
      return [...voy, ...wp];
    },
  },
];
let ddgLast = 0, ddgBlockedUntil = 0;

// Returns the result text handed to the model.
async function webSearch(query) {
  const failed = [];
  for (const b of SEARCH_BACKENDS.filter((b) => b.enabled())) {
    try {
      const results = await b.search(query);
      if (!results.length) { failed.push(`${b.name}: no results`); continue; }
      const note = b.name.startsWith("Wiki")
        ? "(Web search is unavailable right now; these are Wikivoyage/Wikipedia results. You can still read official websites with fetch_page.)\n\n" : "";
      return note + results.map((x) => `${x.title}\n${x.url}\n${x.snippet}`).join("\n\n");
    } catch (e) { failed.push(`${b.name}: ${e.message}`); }
  }
  return `No results (${failed.join("; ")}). Try a shorter query, or read a known official website with fetch_page.`;
}

// Only public web pages: the model must not be able to reach this computer or the local network.
function isPublicUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(hostname) && hostname.includes(".");
  } catch { return false; }
}

// The site's own links on a page (menu included), so the model can click through instead of guessing URLs.
function siteLinks(html, pageUrl, max = 25) {
  const base = new URL(pageUrl), seen = new Set([base.href.replace(/#.*$/, "")]), out = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    const text = htmlText(m[2]).slice(0, 60);
    u.hash = "";
    if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol) || !text || seen.has(u.href) || /\.(jpe?g|png|gif|svg|zip|mp4)$/i.test(u.pathname)) continue;
    // Skip legal/boilerplate pages that never help plan a trip.
    if (/cdn-cgi|privacy|datenschutz|impressum|imprint|cookie|terms|agb|login|newsletter/i.test(u.pathname + " " + text)) continue;
    seen.add(u.href);
    out.push(`${text}: ${u.href}`);
    if (out.length >= max) break;
  }
  return out;
}

async function getPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(15000) });
  return { res, html: res.ok ? (await res.text()).slice(0, 400000) : "" };
}

async function fetchPage(url) {
  if (!isPublicUrl(url)) return "Only public web pages can be fetched.";
  let res, html;
  try { ({ res, html } = await getPage(url)); }
  catch (e) {
    // Say why, so the model can correct itself (e.g. a guessed domain that doesn't exist).
    const code = e.cause?.code;
    return code === "ENOTFOUND" || code === "EAI_AGAIN" ? "Fetch failed: that domain couldn't be found (it may not exist). Search for the right website first."
      : `Fetch failed: ${code || e.cause?.message || e.message}`;
  }
  if (!res.ok) {
    // A guessed address: show what the site's homepage actually links to.
    const home = new URL(url).origin + "/";
    let links = [];
    if (res.status === 404 && url !== home) {
      try { const h = await getPage(home); links = h.res.ok ? siteLinks(h.html, h.res.url || home, 40) : []; } catch {}
    }
    return `HTTP ${res.status}: that page doesn't exist.${links.length
      ? ` Don't guess addresses; these are the pages the homepage (${home}) links to:\n${links.join("\n")}`
      : " Search for the page instead of guessing its address."}`;
  }
  const text = htmlText(html.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " "));
  const links = siteLinks(html, res.url || url);
  return (text.slice(0, 3500) || "(no readable text)") + (links.length ? `\n\nLinks on this page:\n${links.join("\n")}` : "");
}

function researchPrompt(trip, places) {
  const must = places.filter((p) => trip.mustSee?.includes(p.title)).map((p) => p.title);
  return `You are researching a trip before it gets planned. Use the web_search and fetch_page tools to find facts that matter for these dates:
- opening hours and closing days of the must-see places on the trip dates, and current ticket prices
- festivals, events and public holidays in these places during the trip
- how to get between the cities (train/bus options, travel times, prices)
- anything else date-dependent for the travelers' interests

Trip: ${trip.stays.map((s, i) => `${s.city}${s.country ? ` (${s.country})` : ""} from ${s.start}, ${s.nights} night(s)${i && MODE_TEXT[s.travel] ? `, arriving ${MODE_TEXT[s.travel]}` : ""}${(s.dayTrips || []).filter((t) => t.place).map((t) => `, day trip to ${t.place}${MODE_TEXT[t.mode] ? ` ${MODE_TEXT[t.mode]}` : ""}`).join("")}`).join("; ")}.
Travelers: ${trip.travelers}. Interests: ${trip.interests || "none given"}. Notes: ${trip.notes || "none"}.
${must.length ? `Must-see places: ${must.join(", ")}.` : ""}

You can make up to ${MAX_LOOKUPS} tool calls, so be thorough: when you come across places or events worth including, look those up too. Prefer official websites, and read the most useful pages with fetch_page instead of relying on snippets. Short search queries work best. Never guess web addresses: only fetch URLs that appeared in search results or in the "Links on this page" list of a page you read (follow those links to reach opening-hours or ticket pages). When you are done, reply with a concise summary of your findings as "- " bullet points, each ending with its source URL in brackets. Don't plan the itinerary itself.`;
}

// Runs the research conversation; returns { notes, urls }. Throws "NO_TOOLS" if the model can't use tools.
async function localResearch({ kind, base, model, trip, places, onEvent, onThinking, tick, abort }) {
  const messages = [{ role: "user", content: researchPrompt(trip, places) }];
  onEvent({
    type: "prompt", label: "Research prompt",
    info: `Sent to ${kind === "ollama" ? "Ollama" : OPENAI_COMPAT.find(([, b]) => b === base)?.[0] || base} · model: ${model} · tools: web_search, fetch_page (run by the planner) · temperature 0.3`
      + `${kind === "ollama" ? ` · context ${RESEARCH_CTX.toLocaleString()} tokens` : ""} · up to ${MAX_LOOKUPS} lookups. ${kind === "ollama" ? "Ollama adds the model's own system prompt, if it has one." : ""}`,
    text: messages[0].content,
  });
  const urls = [];
  let lookups = 0;
  onEvent({ type: "status", text: "Researching online…" });

  const maxRounds = MAX_LOOKUPS + 2;
  for (let round = 0; round < maxRounds; round++) {
    // The last round has no tools, so the model has to write its summary.
    const allowTools = lookups < MAX_LOOKUPS && round < maxRounds - 1;
    let content = "", calls = [];
    if (kind === "ollama") {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST", signal: abort,
        body: JSON.stringify({ model, stream: true, messages, ...(allowTools ? { tools: RESEARCH_TOOLS } : {}), options: { num_ctx: RESEARCH_CTX, temperature: 0.3 } }),
      });
      if (!res.ok) {
        const err = await res.text();
        if (/does not support tools/i.test(err)) throw new Error("NO_TOOLS");
        throw new Error(`Ollama: ${err.slice(0, 300)}`);
      }
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);
        if (ev.message?.thinking || ev.message?.content) tick();
        if (ev.message?.thinking) onThinking(ev.message.thinking);
        if (ev.message?.content) content += ev.message.content;
        if (ev.message?.tool_calls) calls.push(...ev.message.tool_calls.map((c) => ({ name: c.function.name, args: c.function.arguments || {} })));
      }
      messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}) });
    } else {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST", signal: abort, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, temperature: 0.3, messages, ...(allowTools ? { tools: RESEARCH_TOOLS } : {}) }),
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 422) throw new Error("NO_TOOLS");
        throw new Error(`${base}: ${(await res.text()).slice(0, 300)}`);
      }
      const msg = (await res.json()).choices?.[0]?.message || {};
      if (msg.reasoning_content || msg.reasoning) onThinking(msg.reasoning_content || msg.reasoning);
      content = msg.content || "";
      calls = (msg.tool_calls || []).map((c) => {
        let args = {};
        try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments || {}; } catch {}
        return { id: c.id, name: c.function.name, args };
      });
      messages.push({ role: "assistant", content, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    }

    if (!calls.length) return { notes: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), urls };

    for (const c of calls) {
      let result;
      if (lookups >= MAX_LOOKUPS) result = "Lookup limit reached; summarize what you have.";
      else if (c.name === "web_search" && c.args.query) {
        lookups++;
        onEvent({ type: "search", query: c.args.query });
        result = await webSearch(c.args.query).catch((e) => `Search failed: ${e.message}`);
      } else if (c.name === "fetch_page" && c.args.url) {
        lookups++;
        onEvent({ type: "fetch", url: c.args.url });
        urls.push(c.args.url);
        result = await fetchPage(c.args.url).catch((e) => `Fetch failed: ${e.message}`);
      } else result = "Unknown tool or missing argument.";
      onEvent({ type: "prompt", label: `Result of ${c.name}(${c.args.query || c.args.url || ""})`, text: result });
      messages.push(kind === "ollama" ? { role: "tool", tool_name: c.name, content: result } : { role: "tool", tool_call_id: c.id, content: result });
    }
  }
  return { notes: "", urls };
}

async function runLocal(trip, places, onEvent = () => {}, abort) {
  const [, kind, base, model] = trip.model.split("|");
  const t0 = Date.now();
  let raw = "", content = "", thinking = "", inlineThought = 0, days = 0, lastNotes = "";
  // Some reasoning models (e.g. DeepSeek-R1 on llama.cpp) put their thinking inline as <think>…</think> before the answer.
  const onContent = (piece) => {
    raw += piece;
    const m = raw.match(/^\s*<think>([\s\S]*?)(<\/think>|$)([\s\S]*)$/);
    if (m) {
      if (m[1].length > inlineThought) { onThinking(m[1].slice(inlineThought)); inlineThought = m[1].length; }
      if (!m[2]) return;
      piece = m[3].slice(content.length);
    }
    content += piece;
    const notes = partialNotes(content);
    if (notes != null && notes !== lastNotes) { lastNotes = notes; onEvent({ type: "notes", text: notes }); }
    const n = (content.match(/"date"\s*:/g) || []).length;
    if (n !== days) { days = n; onEvent({ type: "progress", days }); }
  };
  const onThinking = (piece) => { thinking += piece; onEvent({ type: "thought", text: piece }); };
  // Local servers stream one token per chunk, so counting chunks counts tokens.
  let tokens = 0, perSec;
  const meter = tokenMeter(onEvent, false);
  const tick = () => meter(++tokens);

  // Optional research first; its findings and sources go into the planning prompt.
  let research = null;
  if (trip.research) {
    try {
      research = await localResearch({ kind, base, model, trip, places, onEvent, onThinking, tick, abort });
      if (research.notes) onEvent({ type: "notes", text: `**Research findings**\n\n${research.notes}` });
    } catch (e) {
      // Research is a bonus: if it fails (no tool support, odd server reply), plan without it rather than fail the run.
      if (abort?.aborted) throw e;
      const why = e.message === "NO_TOOLS" ? `${model} can't use tools` : `Research failed (${e.message.slice(0, 120)})`;
      onEvent({ type: "status", text: `${why}, so it plans without web research…` });
      onEvent({ type: "notes", text: `**No web research:** ${why}.` });
      await new Promise((r) => setTimeout(r, 1500)); // leave the message readable for a moment
    }
    onEvent({ type: "status", text: "Planning the itinerary…" });
  }
  const prompt = buildPrompt({ ...trip, researchNotes: research?.notes }, places, { local: true });
  const researchTokens = tokens;

  if (kind === "ollama") {
    let canThink = false;
    try {
      const info = await (await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }) })).json();
      canThink = (info.capabilities || []).includes("thinking");
    } catch {}
    // The context window must hold the prompt, the thinking and the whole JSON answer (about 1k tokens per day).
    // Ollama's default is only a few thousand tokens, and running out ends the answer early.
    const tripDays = trip.revise?.itinerary?.days?.length || trip.stays.reduce((n, s) => n + (Number(s.nights) || 0), 0) + 1;
    const needed = Math.ceil(prompt.length / 3) + tripDays * 1000 + 4000 + (canThink ? 16000 : 0);
    const num_ctx = Math.min(Number(process.env.OLLAMA_NUM_CTX) || 65536, Math.ceil(needed / 4096) * 4096);
    onEvent({
      type: "prompt", label: "Planning prompt",
      info: `Sent to Ollama /api/chat · model: ${model} · context ${num_ctx.toLocaleString()} tokens · temperature 0.4 · thinking ${canThink ? "on" : "off"} · `
        + "output forced to the JSON schema at the end of the prompt (Ollama's format option). Ollama adds the model's own system prompt, if it has one.",
      text: prompt,
    });
    const chat = (think) => fetch(`${base}/api/chat`, {
      method: "POST", signal: abort,
      body: JSON.stringify({
        model, stream: true, format: LOCAL_SCHEMA, ...(think ? { think: true } : {}),
        messages: [{ role: "user", content: prompt }], options: { num_ctx, temperature: 0.4 },
      }),
    });
    // Some thinking models only take a thinking level, not on/off; then run without it rather than fail.
    let res = await chat(canThink);
    if (!res.ok && canThink) res = await chat(false);
    if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 500)}`);
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(`Ollama: ${ev.error}`);
      if (ev.message?.thinking || ev.message?.content) tick();
      if (ev.message?.thinking) onThinking(ev.message.thinking);
      if (ev.message?.content) onContent(ev.message.content);
      // The last line has Ollama's exact count and generation speed.
      if (ev.done && ev.eval_count) {
        tokens = researchTokens + ev.eval_count;
        perSec = ev.eval_duration ? ev.eval_count / (ev.eval_duration / 1e9) : undefined;
        meter(tokens, { force: true, perSec });
      }
      if (ev.done && ev.done_reason === "length") {
        throw new Error(`${model} ran out of context (${num_ctx.toLocaleString()} tokens) ${content.trim() ? "before finishing the itinerary" : "while still thinking, before writing anything"}. `
          + "Try fewer saved places or a shorter trip, or raise the limit by setting OLLAMA_NUM_CTX (e.g. 98304) before starting the planner.");
      }
    }
  } else {
    // OpenAI-compatible server. Ask for schema-constrained JSON; if the server rejects that, retry relying on the prompt alone.
    const request = (withSchema) => fetch(`${base}/v1/chat/completions`, {
      method: "POST", signal: abort, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, stream: true, temperature: 0.4, messages: [{ role: "user", content: prompt }],
        ...(withSchema ? { response_format: { type: "json_schema", json_schema: { name: "itinerary", schema: LOCAL_SCHEMA } } } : {}),
      }),
    });
    onEvent({
      type: "prompt", label: "Planning prompt",
      info: `Sent to ${OPENAI_COMPAT.find(([, b]) => b === base)?.[0] || base} (/v1/chat/completions) · model: ${model} · temperature 0.4 · `
        + "output asked for as JSON matching the schema at the end of the prompt (enforced if the server supports it).",
      text: prompt,
    });
    let res = await request(true);
    if (res.status === 400 || res.status === 422) res = await request(false);
    if (!res.ok) throw new Error(`${base}: ${(await res.text()).slice(0, 500)}`);
    for await (const line of lines(res.body)) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
      const delta = JSON.parse(data).choices?.[0]?.delta || {};
      const think = delta.reasoning_content || delta.reasoning;
      if (think || delta.content) tick();
      if (think) onThinking(think);
      if (delta.content) onContent(delta.content);
    }
  }

  let parsed;
  try { parsed = parseJsonLoose(content); } catch {}
  const itinerary = normalizeItinerary(parsed, Number(trip.travelers) || 1);
  if (!itinerary) {
    const why = !content.trim()
      ? (thinking ? `It only thought (${thinking.length.toLocaleString()} characters) and never wrote the itinerary.` : "It returned nothing.")
      : "Its answer wasn't a valid itinerary.";
    throw new Error(`${model} didn't return a usable itinerary. ${why} Try again, a bigger model, or fewer saved places.`
      + (content.trim() ? `\n\nIts answer began:\n${content.slice(0, 600)}` : thinking ? `\n\nEnd of its thinking:\n…${thinking.slice(-600)}` : ""));
  }
  let reasoning = String(itinerary.planningNotes || "").trim();
  delete itinerary.planningNotes;
  if (research?.notes) {
    reasoning += `\n\n**Research findings**\n\n${research.notes}`;
    const found = [...new Set([...research.urls, ...(research.notes.match(/https?:\/\/[^\s)\]]+/g) || [])])];
    if (!itinerary.sources?.length) itinerary.sources = found;
  }
  return { itinerary, reasoning, thinking: thinking.trim().slice(0, 20000), durationMs: Date.now() - t0, tokens, perSec, engine: `${model} (${kind === "ollama" ? "Ollama" : OPENAI_COMPAT.find(([, b]) => b === base)?.[0] || base})` };
}

// ---------- HTTP ----------

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });
}
async function readJson(req) {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

// Saved trips live in saves/<name>.json.
function savePath(name) {
  const clean = cleanName(name);
  return clean ? path.join(SAVES_DIR, clean + ".json") : null;
}

function listSaves() {
  if (!fs.existsSync(SAVES_DIR)) return [];
  return fs.readdirSync(SAVES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.slice(0, -5), savedAt: fs.statSync(path.join(SAVES_DIR, f)).mtime }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

async function handleSaves(req, res, name) {
  if (req.method === "GET" && !name) return sendJson(res, 200, listSaves());
  const file = savePath(name);
  if (!file) return sendJson(res, 400, { error: "Give the save a name (letters, numbers, spaces, - or _)." });
  if (req.method === "GET") {
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: "No such save" });
    return sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    try { JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    fs.mkdirSync(SAVES_DIR, { recursive: true });
    fs.writeFileSync(file, body);
    return sendJson(res, 200, { name: path.basename(file, ".json") });
  }
  if (req.method === "DELETE") {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(405).end();
}

async function handleLists(req, res, name, action) {
  if (!name) return req.method === "GET" ? sendJson(res, 200, listSummaries()) : res.writeHead(405).end();

  if (name === "import" && req.method === "POST") {
    const body = await readJson(req);
    if (!body?.url) return sendJson(res, 400, { error: "Paste a Google Maps list link." });
    const { title, places } = await fetchGoogleList(body.url.trim());
    const listName = cleanName(body.name) || cleanName(title) || "Google list";
    const old = readList(listName);
    const list = writeList({
      name: listName, title, source: { type: "google", url: body.url.trim() },
      places: mergeCoords(places, old?.places), syncedAt: new Date().toISOString(),
    });
    console.log(`Imported Google Maps list "${title}" (${places.length} places) as "${listName}"`);
    return sendJson(res, 200, list);
  }

  if (!listPath(name)) return sendJson(res, 400, { error: "Invalid list name" });
  if (action === "sync" && req.method === "POST") {
    const list = readList(name);
    if (!list) return sendJson(res, 404, { error: "No such list" });
    return sendJson(res, 200, await syncList(list));
  }
  if (req.method === "GET") {
    const list = await getList(name);
    return list ? sendJson(res, 200, list) : sendJson(res, 404, { error: "No such list" });
  }
  if (req.method === "PUT") {
    const body = await readJson(req);
    if (typeof body?.csv !== "string") return sendJson(res, 400, { error: "Expected { csv }" });
    const places = csvToPlaces(body.csv);
    if (!places.length) return sendJson(res, 400, { error: "No places found in that CSV (it needs a Title or Name column)." });
    const list = writeList({ name: cleanName(name), source: { type: "upload" }, places: mergeCoords(places, readList(name)?.places), syncedAt: new Date().toISOString() });
    return sendJson(res, 200, list);
  }
  if (req.method === "DELETE") {
    const f = listPath(name);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(405).end();
}

function validateTrip(t) {
  if (!t || !Array.isArray(t.stays) || !t.stays.length) return "Add at least one stay.";
  for (const s of t.stays) {
    if (!s.city || !s.start || !(Number(s.nights) >= 0)) return "Every stay needs a city, arrival date and number of nights.";
  }
  if (!(Number(t.dailyBudget) > 0)) return "Set a daily budget.";
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Allow the page to be opened from file:// (origin "null") as well as from this server.
  const origin = req.headers.origin;
  if (origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  }
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  try {
    const saveMatch = url.pathname.match(/^\/api\/saves(?:\/(.+))?$/);
    if (saveMatch) return await handleSaves(req, res, saveMatch[1] && decodeURIComponent(saveMatch[1]));

    const listMatch = url.pathname.match(/^\/api\/lists(?:\/([^/]+))?(?:\/(sync))?$/);
    if (listMatch) return await handleLists(req, res, listMatch[1] && decodeURIComponent(listMatch[1]), listMatch[2]);

    if (req.method === "POST" && url.pathname === "/api/geocode") {
      const body = await readJson(req);
      return sendJson(res, 200, geocodeBatch(Array.isArray(body?.queries) ? body.queries : []));
    }

    if (req.method === "POST" && url.pathname === "/api/routes") {
      const body = await readJson(req);
      return sendJson(res, 200, routeBatch(Array.isArray(body?.legs) ? body.legs : []));
    }

    // Start fetching real places for the trip's stays in the background, so generating doesn't have to wait.
    if (req.method === "POST" && url.pathname === "/api/nearby/warm") {
      const body = await readJson(req);
      const stays = (Array.isArray(body?.stays) ? body.stays : []).filter((s) => s?.city).slice(0, 20);
      pool(stays, 2, (s) => nearbyElements(s.city, s.cc).catch((e) => console.error(`Nearby places for ${s.city} failed:`, e.message)));
      return sendJson(res, 202, { warming: stays.length });
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      return sendJson(res, 200, { claude: !!findClaude(), local: await detectLocalModels() });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJson(res, 400, { error: "Type a place name" });
      const p = (k) => (url.searchParams.has(k) ? +url.searchParams.get(k) : NaN);
      return sendJson(res, 200, await searchPlaces(q, p("lat"), p("lng"), url.searchParams.get("cc") || ""));
    }

    if (req.method === "GET" && url.pathname === "/api/reverse") {
      const lat = +url.searchParams.get("lat"), lng = +url.searchParams.get("lng");
      if (!isFinite(lat) || !isFinite(lng)) return sendJson(res, 400, { error: "lat and lng required" });
      return sendJson(res, 200, (await reverseGeocode(lat, lng)) || {});
    }

    if (req.method === "POST" && url.pathname === "/api/itinerary") {
      const trip = await readJson(req);
      if (!trip) return sendJson(res, 400, { error: "Invalid JSON" });
      const problem = validateTrip(trip);
      if (problem) return sendJson(res, 400, { error: problem });
      // Places picked on the map ride along with the trip.
      const extra = Array.isArray(trip.extraPlaces) ? trip.extraPlaces.filter((p) => p?.title) : [];
      // Older map-picked places were saved without an address; look it up so the model knows where they are.
      for (const p of extra) {
        if (!p.address && typeof p.lat === "number") p.address = (await reverseGeocode(p.lat, p.lng).catch(() => null))?.short || "";
      }
      const places = [...(trip.list ? (await getList(trip.list))?.places || [] : []), ...extra];
      console.log(`${trip.revise ? "Revising" : "Generating"} itinerary: ${trip.stays.map((s) => `${s.city} (${s.nights}n)`).join(" -> ")}`);
      // Stream newline-delimited JSON: progress events while Claude works, then one "done" (or "error") line.
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const send = (ev) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableFinished) abort.abort(); });
      try {
        send({ type: "status", text: "Looking up holidays and real places near your stays…" });
        trip.holidays = await tripHolidays(trip).catch(() => []);
        trip.nearby = await nearbyPlaces(trip, (text) => send({ type: "status", text }));
        // The page uses these to put stops on the map at their exact spot.
        send({ type: "pois", places: trip.nearby.flatMap((n) => [...n.sights, ...n.food].map(({ name, lat, lng }) => ({ name, lat, lng, city: n.city }))) });
        const run = String(trip.model || "").startsWith("local|") ? runLocal : runClaude;
        const result = await run(trip, places, send, abort.signal);
        console.log(`Done in ${(result.durationMs / 1000).toFixed(0)}s`);
        send({ type: "done", ...result });
      } catch (e) {
        console.error(e.message);
        send({ type: "error", error: e.message });
      }
      return res.end();
    }
  } catch (e) {
    console.error(e.message);
    return sendJson(res, 500, { error: e.message });
  }

  if (req.method === "GET") {
    const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  res.writeHead(405).end();
});

adoptCsvFiles();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Trip planner running at http://localhost:${PORT}`);
  console.log(`Place lists: ${listSummaries().map((l) => `${l.name} (${l.count})`).join(", ") || "none yet"}`);
  console.log(`Claude CLI: ${findClaude() || "NOT FOUND (set CLAUDE_BIN)"}`);
});
