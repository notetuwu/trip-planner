// All /api routes. Used by the production server (main.ts) and mounted into Vite's dev server (vite.config.ts).
import fs from "node:fs";
import { cloudModels } from "./ai/cloud-models";
import { detectLocalModels } from "./ai/local-models";
import { ensureOllama, gpuInfo, ollamaInstalled } from "./ai/ollama-start";
import { findClaude } from "./ai/claude-bin";
import { SAVES_DIR, VERSION, errMsg } from "./config";
import { geocodeBatch, geocodeStatus } from "./geo/geocode";
import { routeBatch } from "./geo/routing";
import { cellStatus, clearLines, linesFor, linesLocation, linesOnDisk, linesProgress, prefetchLines, cancelLines, localLine, routeStops, routesStops, setLinesDir } from "./geo/transit-lines";
import { localThumb } from "./geo/local-photos";
import { deletePhoto, driveThumb, folderPhotos, photoFile } from "./geo/photos";
import { placePictures } from "./geo/wiki-photos";
import { pickFolder } from "./util/pick-folder";
import { fsCheck, fsList, fsMkdir, fsPlaces } from "./util/fs-browse";
import { reverseGeocode, searchPlaces } from "./geo/search";
import { type Box, searchAreaKinds, searchAreaNames } from "./geo/area-search";
import { adoptCsvFiles, listSummaries } from "./lists/store";
import { isProvider, keyStatus, loadEnvFile, setKey } from "./keys";
import { checkTier, geminiKeyChanged, geminiStatus } from "./ai/gemini";
import { usageInfo } from "./ai/usage-notices";
import { openFolder, openInBrowser } from "./launcher";
import { handleItinerary } from "./routes/itinerary";
import { handleLists } from "./routes/lists";
import { handleHistory, handleRescue, handleSaves } from "./routes/saves";
import { tripCards } from "./routes/trips";
import { handleLan, handleSettings } from "./routes/settings";
import { handleOllama } from "./routes/ollama";
import { handleSearxng, searxngInfo, startSearxngIfChosen } from "./routes/searxng";
import { readSettings } from "./settings";
import { handleCurrent } from "./routes/current";
import { handleSync } from "./routes/sync";
import { startSyncTimer } from "./sync/sync";
import { handleUpdate } from "./routes/update";
import { checkHours } from "./trip/hours";
import { lookupHours } from "./trip/hours-online";
import { eurRates, fuelPrices } from "./trip/fuel";
import { warmNearby } from "./trip/nearby";
import { suggestStops } from "./trip/stops";
import { planRoute } from "./trip/route-plan";
import { askCompanion, compactChat } from "./trip/companion";
import { streamProgress } from "./util/progress-stream";
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
  // Research goes to SearXNG on this computer: have Docker and it running by the time it's needed.
  setTimeout(startSearxngIfChosen, 4000);
  // Trips synced with Drive folders (only when signed in): a look a little after start, then every few minutes.
  startSyncTimer();
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
    // Your trips → Open folder: where the saved trips are on this computer (never from a phone: lan.ts).
    if (method === "POST" && path === "/api/open/saves") {
      fs.mkdirSync(SAVES_DIR, { recursive: true });
      openFolder(SAVES_DIR);
      sendJson(res, 200, { ok: true }); return true;
    }
    if (path === "/api/settings") { await handleSettings(req, res); return true; }
    if (path === "/api/lan" || path.startsWith("/api/lan/")) { await handleLan(req, res, path); return true; }
    if (path === "/api/ollama" || path.startsWith("/api/ollama/")) { await handleOllama(req, res, path); return true; }
    if (path === "/api/searxng" || path.startsWith("/api/searxng/")) { await handleSearxng(req, res, path); return true; }
    if (path === "/api/current") { await handleCurrent(req, res); return true; }
    if (path === "/api/sync" || path.startsWith("/api/sync/")) { await handleSync(req, res, path); return true; }
    if (path === "/api/trips" && method === "GET") { sendJson(res, 200, tripCards()); return true; }
    if (path === "/api/bye") { goodbye(url.searchParams.get("id") || ""); sendJson(res, 200, { ok: true }); return true; }
    // Earlier versions of a saved trip, and copies of the open trip from before it was replaced.
    const histMatch = path.match(/^\/api\/saves\/([^/]+)\/history(?:\/(\d+))?$/), rescueMatch = path.match(/^\/api\/rescue(?:\/(\d+))?$/);
    if (histMatch) { await handleHistory(req, res, decodeURIComponent(histMatch[1]), histMatch[2]); return true; }
    if (rescueMatch) { await handleRescue(req, res, rescueMatch[1]); return true; }
    const saveMatch = path.match(/^\/api\/saves(?:\/(.+))?$/);
    const listMatch = path.match(/^\/api\/lists(?:\/([^/]+))?(?:\/(sync))?$/);
    if (saveMatch) await handleSaves(req, res, saveMatch[1] && decodeURIComponent(saveMatch[1]));
    else if (listMatch) await handleLists(req, res, listMatch[1] && decodeURIComponent(listMatch[1]), listMatch[2]);
    else if (method === "GET" && path === "/api/geocode/status") sendJson(res, 200, geocodeStatus());
    else if (method === "POST" && path === "/api/geocode") {
      const body = await readJson(req);
      sendJson(res, 200, geocodeBatch(Array.isArray(body?.queries) ? body.queries : []));
    }
    else if (method === "POST" && path === "/api/routes") {
      const body = await readJson(req);
      sendJson(res, 200, routeBatch(Array.isArray(body?.legs) ? body.legs : []));
    }
    // The photos of a shared Google Drive folder, for the map's Photos layer ("?folder=<link or id>[&refresh=1]").
    else if (method === "GET" && path === "/api/photos") {
      try {
        const list = await folderPhotos(url.searchParams.get("folder") || "", url.searchParams.get("refresh") === "1");
        // Deleting stays on this computer (lan.ts): a phone isn't offered it.
        sendJson(res, 200, (req as Req & { lan?: boolean }).lan ? { ...list, photos: list.photos.map(({ del: _, ...p }) => p) } : list);
      }
      catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    // Deletes a photo's file, or removes it from its folder: { folder, id, how } (how: what was agreed to).
    else if (method === "POST" && path === "/api/photos/delete") {
      const body = await readJson(req);
      const how = body?.how === "permanent" || body?.how === "remove" ? body.how : "trash";
      try { await deletePhoto(String(body?.folder || ""), String(body?.id || ""), how); sendJson(res, 200, { ok: true }); }
      catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    // A photo's original file (the viewer swaps it in for the thumbnail): "?folder=<link or id>&id=<file id>".
    else if (method === "GET" && path === "/api/photos/image") {
      try { await photoFile(url.searchParams.get("folder") || "", url.searchParams.get("id") || "", res, String(req.headers.range || "")); }
      catch (e) { if (!res.headersSent) sendJson(res, 502, { error: errMsg(e) }); else res.destroy(); }
    }
    // A small picture of a photo or video from a folder on this computer: "?folder=local:<path>&id=<file>&px=s220".
    else if (method === "GET" && path === "/api/photos/thumb") {
      const folder = url.searchParams.get("folder") || "";
      // A Drive photo read as the signed-in account (its thumbnail only shows for that account).
      if (!/^local:/i.test(folder)) { try { await driveThumb(folder, url.searchParams.get("id") || "", Number((url.searchParams.get("px") || "").replace(/^s/, "")) || 220, res); } catch (e) { if (!res.headersSent) sendJson(res, 502, { error: errMsg(e) }); else res.destroy(); } }
      else try { await localThumb(url.searchParams.get("folder") || "", url.searchParams.get("id") || "", Number((url.searchParams.get("px") || "").replace(/^s/, "")) || 220, res); }
      catch (e) { if (!res.headersSent) sendJson(res, 502, { error: errMsg(e) }); else res.destroy(); }
    }
    // Pictures of places from Wikimedia, for the trip preview; only when switched on.
    else if (method === "POST" && path === "/api/place-pictures") {
      if (!readSettings().app.placePictures) sendJson(res, 403, { error: "Pictures from Wikimedia are switched off" });
      else {
        const body = await readJson(req);
        const places = (Array.isArray(body?.places) ? body.places : []).slice(0, 20)
          .filter((p: any) => p && typeof p.name === "string" && p.name.trim() && Number.isFinite(p.lat) && Number.isFinite(p.lng))
          .map((p: any) => ({ id: String(p.id), name: p.name.slice(0, 120), city: String(p.city || "").slice(0, 80), cc: String(p.cc || "").slice(0, 2), lat: p.lat, lng: p.lng }));
        sendJson(res, 200, await busyWhile(() => placePictures(places, !!body?.quick)));
      }
    }
    // The system's folder dialog on this computer, to pick the folder with the photos ("" when it's closed without one).
    // The app's folder browser, on this computer: the usual places and drives, what's in a folder, a new folder, a pasted path.
    else if (method === "GET" && path === "/api/fs/places") sendJson(res, 200, { entries: fsPlaces() });
    else if (method === "GET" && path === "/api/fs/list") {
      try { sendJson(res, 200, fsList(url.searchParams.get("path") || "")); } catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    else if (method === "POST" && path === "/api/fs/mkdir") {
      const body = await readJson(req);
      try { sendJson(res, 200, fsMkdir(String(body?.parent || ""), String(body?.name || ""))); } catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    else if (method === "GET" && path === "/api/fs/check") {
      try { sendJson(res, 200, fsCheck(url.searchParams.get("path") || "")); } catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    else if (method === "POST" && path === "/api/pick-folder") {
      try { sendJson(res, 200, { path: await busyWhile(() => pickFolder("Choose the folder with your photos")) }); }
      catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    // The map's transport line overlays, by grid cell ("?cells=940_166,940_167").
    // (Transport lines switched off in Settings → Map: nothing is fetched.)
    else if (method === "GET" && path === "/api/lines") sendJson(res, 200, readSettings().app.transitLines ? linesFor((url.searchParams.get("cells") || "").split(",")) : { cells: {}, pending: 0 });
    // Downloading the trip's areas ahead, in the background (the list replaces the last one); and what's on disk.
    else if (method === "POST" && path === "/api/lines/prefetch") {
      const body = await readJson(req);
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      const on = readSettings().app.transitLines;
      sendJson(res, 200, { ...prefetchLines(on ? list(body?.cells) : [], on ? list(body?.first) : [], list(body?.again)), disk: linesOnDisk() });
    }
    // Stopping the download of some areas (the × on the map's grid, Cancel in the Layers panel).
    else if (method === "POST" && path === "/api/lines/cancel") {
      const body = await readJson(req);
      sendJson(res, 200, cancelLines(Array.isArray(body?.cells) ? body.cells.map(String) : []));
    }
    // For the map's area grid: which cells are downloaded, being fetched, waiting or failed.
    else if (method === "POST" && path === "/api/lines/status") {
      const body = await readJson(req);
      sendJson(res, 200, cellStatus(Array.isArray(body?.cells) ? body.cells.map(String) : []));
    }
    else if (method === "GET" && path === "/api/lines/disk") sendJson(res, 200, { ...linesOnDisk(), location: linesLocation() });
    // Keeping the downloads in another folder (what's there is moved across); "" = back to the app's cache folder.
    else if (method === "POST" && path === "/api/lines/location") {
      const body = await readJson(req);
      try { sendJson(res, 200, { location: await setLinesDir(String(body?.dir ?? "")), ...linesOnDisk() }); }
      catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    else if (method === "GET" && path === "/api/lines/progress") sendJson(res, 200, linesProgress());
    // A line's stops in order (the map's stop card), fetched once and kept.
    // A line's stops in order from the downloaded areas, at once ("?ids=<its routes>&at=<lat>,<lng>").
    else if (method === "GET" && path === "/api/lines/local") {
      const [lat, lng] = (url.searchParams.get("at") || "").split(",").map(Number);
      const r = localLine((url.searchParams.get("ids") || "").split(",").map(Number), lat, lng);
      sendJson(res, r ? 200 : 404, r || { error: "No downloaded area has this line" });
    }
    // The stops of all the lines at a stop, fetched in one go when its card opens ("?ids=1,2,3").
    else if (method === "GET" && path === "/api/lines/routes") {
      try { sendJson(res, 200, await routesStops((url.searchParams.get("ids") || "").split(",").map(Number))); }
      catch (e) { sendJson(res, 502, { error: `Couldn't get the lines' stops: ${errMsg(e)}` }); }
    }
    else if (method === "GET" && path === "/api/lines/route") {
      try {
        const r = await routeStops(Number(url.searchParams.get("id")));
        sendJson(res, r ? 200 : 404, r || { error: "No such line" });
      } catch (e) { sendJson(res, 502, { error: `Couldn't get the line's stops: ${errMsg(e)}` }); }
    }
    else if (method === "DELETE" && path === "/api/lines") { clearLines(); sendJson(res, 200, linesOnDisk()); }
    // Start fetching real places for the trip's stays in the background, so generating doesn't have to wait.
    else if (method === "POST" && path === "/api/nearby/warm") {
      const body = await readJson(req);
      sendJson(res, 202, { warming: warmNearby(Array.isArray(body?.stays) ? body.stays : []) });
    }
    else if (method === "GET" && path === "/api/models") {
      const ollamaUp = await ensureOllama(); // starts an installed Ollama that isn't running
      const [local, cloud] = await Promise.all([detectLocalModels(), cloudModels()]);
      sendJson(res, 200, { claude: !!findClaude(), local, cloud: cloud.models, errors: cloud.errors, keys: keyStatus(),
        ollama: { installed: ollamaInstalled(), running: ollamaUp } });
    }
    // The quick-start guide: what's there to plan with (Claude Code, API keys, Ollama and its models) and to research
    // with (the search engine, a Brave key, Docker and SearXNG).
    else if (method === "GET" && path === "/api/setup") {
      const s = readSettings(), ollamaUp = await ensureOllama();
      const [local, searxng] = await Promise.all([detectLocalModels(), searxngInfo()]);
      sendJson(res, 200, {
        claude: !!findClaude(), keys: keyStatus(),
        ollama: { installed: ollamaInstalled(), running: ollamaUp }, localModels: local.length,
        search: s.tune.search, braveKey: !!(s.braveKey || process.env.BRAVE_API_KEY), searxngUrl: s.searxngUrl, searxng,
      });
    }
    else if (method === "GET" && path === "/api/gpu") {
      sendJson(res, 200, await gpuInfo());
    }
    else if (method === "PUT" && path.startsWith("/api/keys/")) {
      const provider = path.slice("/api/keys/".length), body = await readJson(req);
      if (!isProvider(provider)) sendJson(res, 404, { error: "Unknown provider" });
      else {
        setKey(provider, String(body?.key || ""));
        if (provider === "gemini") geminiKeyChanged();
        sendJson(res, 200, keyStatus());
      }
    }
    // A warning that the model's usage is critical (above the chat's message box), and Claude's limits.
    else if (method === "GET" && path === "/api/usage") {
      sendJson(res, 200, await usageInfo(new URL(req.url || "", "http://localhost").searchParams.get("model") || ""));
    }
    // The Gemini key: its tier, today's requests per model and the limits Google named; check checks the tier again.
    else if (method === "GET" && path === "/api/gemini") {
      sendJson(res, 200, await geminiStatus());
    }
    else if (method === "POST" && path === "/api/gemini/check") {
      await checkTier();
      sendJson(res, 200, await geminiStatus());
    }
    // Overnight stops between two stays on a long drive (route + the selected model).
    else if (method === "POST" && path === "/api/stops") {
      const body = await readJson(req);
      if (!body?.from || !body?.to || !body?.model) sendJson(res, 400, { error: "from, to and model are needed" });
      else await busyWhile(() => streamProgress(res, (report, signal) => suggestStops(body, report, signal)));
    }
    // Plan the stays of a trip from a description (the selected model, then real road checks).
    else if (method === "POST" && path === "/api/route-plan") {
      const body = await readJson(req);
      if (!body?.start || !body?.model) sendJson(res, 400, { error: "A start and a model are needed" });
      else await busyWhile(() => streamProgress(res, (report, signal) => planRoute(body, report, signal)));
    }
    // The trip chat: a question about the trip on screen, answered by the selected model.
    else if (method === "POST" && path === "/api/companion/compact") {
      const body = await readJson(req);
      if (!body?.model) sendJson(res, 400, { error: "A model is needed" });
      else await busyWhile(() => streamProgress(res, (report, signal) => compactChat(body, report, signal)));
    }
    else if (method === "POST" && path === "/api/companion") {
      const body = await readJson(req);
      if (!body?.question || !body?.model) sendJson(res, 400, { error: "A question and a model are needed" });
      else await busyWhile(() => streamProgress(res, (report, signal) => askCompanion(body, report, signal)));
    }
    // Opening hours from the web for stops OpenStreetMap has none for ("Check opening hours online").
    else if (method === "POST" && path === "/api/hours/online") {
      const body = await readJson(req);
      await busyWhile(() => streamProgress(res, (report) => lookupHours(body || {}, report)));
    }
    else if (method === "POST" && path === "/api/hours") {
      const body = await readJson(req);
      sendJson(res, 200, (Array.isArray(body?.checks) ? body.checks : []).slice(0, 500).map(checkHours));
    }
    // A chain or a kind of place in the map's view: names at once (what=names), kinds of place when they come (what=kinds).
    else if (method === "GET" && path === "/api/search/area") {
      const q = (url.searchParams.get("q") || "").trim();
      const box = ["s", "w", "n", "e"].map((k) => Number(url.searchParams.get(k))) as Box;
      try { sendJson(res, 200, await (url.searchParams.get("what") === "kinds" ? searchAreaKinds : searchAreaNames)(q, box)); }
      catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
    }
    else if (method === "GET" && path === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const num = (k: string) => (url.searchParams.has(k) ? +url.searchParams.get(k)! : NaN);
      if (!q) sendJson(res, 400, { error: "Type a place name" });
      else sendJson(res, 200, await searchPlaces(q, num("lat"), num("lng"), url.searchParams.get("cc") || "", url.searchParams.get("quick") === "1"));
    }
    // The fuel estimate: fuel prices per country (?cc=DE,AT) and euro exchange rates.
    else if (method === "GET" && path === "/api/fuel") sendJson(res, 200, await fuelPrices((url.searchParams.get("cc") || "").split(",")));
    else if (method === "GET" && path === "/api/fx") sendJson(res, 200, await eurRates());
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
