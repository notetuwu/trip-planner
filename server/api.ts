// All /api routes. Used by the production server (main.ts) and mounted into Vite's dev server (vite.config.ts).
import { detectLocalModels } from "./ai/local-models";
import { findClaude } from "./ai/claude-bin";
import { errMsg } from "./config";
import { geocodeBatch } from "./geo/geocode";
import { routeBatch } from "./geo/routing";
import { reverseGeocode, searchPlaces } from "./geo/search";
import { adoptCsvFiles, listSummaries } from "./lists/store";
import { handleItinerary } from "./routes/itinerary";
import { handleLists } from "./routes/lists";
import { handleSaves } from "./routes/saves";
import { warmNearby } from "./trip/nearby";
import { type Req, type Res, readJson, sendJson } from "./util/http";

/** Runs once when the server starts. */
export function startup() {
  adoptCsvFiles();
  console.log(`Place lists: ${listSummaries().map((l) => `${l.name} (${l.count})`).join(", ") || "none yet"}`);
  console.log(`Claude CLI: ${findClaude() || "NOT FOUND (set CLAUDE_BIN)"}`);
}

/** Handles an /api request; returns false for anything else. */
export async function handleApi(req: Req, res: Res): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/api/")) return false;
  const { method } = req, path = url.pathname;
  try {
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
    else if (method === "GET" && path === "/api/models") sendJson(res, 200, { claude: !!findClaude(), local: await detectLocalModels() });
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
    else if (method === "POST" && path === "/api/itinerary") await handleItinerary(req, res);
    else sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(errMsg(e));
    if (!res.headersSent) sendJson(res, 500, { error: errMsg(e) });
    else res.end();
  }
  return true;
}
