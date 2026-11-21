// All /api routes. Used by the production server (main.ts) and mounted into Vite's dev server (vite.config.ts).
import { cloudModels } from "./ai/cloud-models";
import { detectLocalModels } from "./ai/local-models";
import { findClaude } from "./ai/claude-bin";
import { VERSION, errMsg } from "./config";
import { geocodeBatch } from "./geo/geocode";
import { routeBatch } from "./geo/routing";
import { reverseGeocode, searchPlaces } from "./geo/search";
import { adoptCsvFiles, listSummaries } from "./lists/store";
import { isProvider, keyStatus, loadEnvFile, setKey } from "./keys";
import { openInBrowser } from "./launcher";
import { handleItinerary } from "./routes/itinerary";
import { handleLists } from "./routes/lists";
import { handleSaves } from "./routes/saves";
import { handleSettings } from "./routes/settings";
import { handleUpdate } from "./routes/update";
import { checkHours } from "./trip/hours";
import { warmNearby } from "./trip/nearby";
import { busyWhile, goodbye, openWindows, ping, touch } from "./util/activity";
import { refuse } from "./util/guard";
import { type Req, type Res, readJson, sendJson } from "./util/http";

/** Runs once when the server starts. */
export function startup() {
  loadEnvFile();
  adoptCsvFiles();
  console.log(`Place lists: ${listSummaries().map((l) => `${l.name} (${l.count})`).join(", ") || "none yet"}`);
  // Looking for the CLI starts a process, so it's done after the server is up rather than delaying it.
  setTimeout(() => console.log(`Claude CLI: ${findClaude() || "NOT FOUND (set CLAUDE_BIN)"}`), 1500);
}

/** Handles an /api request; returns false for anything else. */
export async function handleApi(req: Req, res: Res): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/api/")) return false;
  const { method } = req, path = url.pathname;
  const refused = refuse(req);
  if (refused) { sendJson(res, 403, { error: refused }); return true; }
  touch();
  try {
    if (path === "/api/health") { sendJson(res, 200, { app: "trip-planner", version: VERSION, windows: openWindows() }); return true; }
    // Open windows check in (and say goodbye when closed), so the packaged app knows when to quit.
    if (path === "/api/ping") { ping(url.searchParams.get("id") || ""); sendJson(res, 200, { ok: true }); return true; }
    if (path.startsWith("/api/update")) { await handleUpdate(req, res, path); return true; }
    // The app's own window sends external links here, to open in the default browser.
    if (method === "POST" && path === "/api/open") {
      const body = await readJson(req);
      sendJson(res, openInBrowser(String(body?.url || "")) ? 200 : 400, { ok: true }); return true;
    }
    if (path === "/api/settings") { await handleSettings(req, res); return true; }
    if (path === "/api/bye") { goodbye(url.searchParams.get("id") || ""); sendJson(res, 200, { ok: true }); return true; }
    const saveMatch = path.match(/^\/api\/saves(?:\/(.+))?$/);
    const listMatch = path.match(/^\/api\/lists(?:\/([^/]+))?(?:\/(sync))?$/);
    if (saveMatch) await handleSaves(req, res, saveMatch[1] && decodeURIComponent(saveMatch[1]));
    else if (listMatch) await handleLists(req, res, listMatch[1] && decodeURIComponent(listMatch[1]), listMatch[2]);
    else if (method === "POST" && path === "/api/geocode") {
      const body = await readJson(req);
      sendJson(res, 200, geocodeBatch(Array.isArray(body?.queries) ? body.queries : []));
    }
    else if (method === "POST" && path === "/api/routes") {
      const body = await readJson(req);
      sendJson(res, 200, routeBatch(Array.isArray(body?.legs) ? body.legs : []));
    }
    // Start fetching real places for the trip's stays in the background, so generating doesn't have to wait.
    else if (method === "POST" && path === "/api/nearby/warm") {
      const body = await readJson(req);
      sendJson(res, 202, { warming: warmNearby(Array.isArray(body?.stays) ? body.stays : []) });
    }
    else if (method === "GET" && path === "/api/models") {
      const [local, cloud] = await Promise.all([detectLocalModels(), cloudModels()]);
      sendJson(res, 200, { claude: !!findClaude(), local, cloud: cloud.models, errors: cloud.errors, keys: keyStatus() });
    }
    else if (method === "PUT" && path.startsWith("/api/keys/")) {
      const provider = path.slice("/api/keys/".length), body = await readJson(req);
      if (!isProvider(provider)) sendJson(res, 404, { error: "Unknown provider" });
      else { setKey(provider, String(body?.key || "")); sendJson(res, 200, keyStatus()); }
    }
    else if (method === "POST" && path === "/api/hours") {
      const body = await readJson(req);
      sendJson(res, 200, (Array.isArray(body?.checks) ? body.checks : []).slice(0, 500).map(checkHours));
    }
    else if (method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const num = (k: string) => (url.searchParams.has(k) ? +url.searchParams.get(k)! : NaN);
      if (!q) sendJson(res, 400, { error: "Type a place name" });
      else sendJson(res, 200, await searchPlaces(q, num("lat"), num("lng"), url.searchParams.get("cc") || ""));
    }
    else if (method === "GET" && path === "/api/reverse") {
      const lat = +url.searchParams.get("lat")!, lng = +url.searchParams.get("lng")!;
      if (!isFinite(lat) || !isFinite(lng)) sendJson(res, 400, { error: "lat and lng required" });
      else sendJson(res, 200, (await reverseGeocode(lat, lng)) || {});
    }
    else if (method === "POST" && path === "/api/itinerary") await busyWhile(() => handleItinerary(req, res));
    else sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(errMsg(e));
    if (!res.headersSent) sendJson(res, 500, { error: errMsg(e) });
    else res.end();
  }
  return true;
}
