// Saved trips: saves/<name>.json, written and read as-is.
import fs from "node:fs";
import path from "node:path";
import type { SaveSummary } from "../../shared/types";
import { SAVES_DIR, cleanName } from "../config";
import { type Req, type Res, readBody, readJson, sendJson } from "../util/http";
import { afterSave, beforeDelete, saveSyncInfo, staleWrite } from "../sync/sync";
import { keepRescue, keepVersion, listRescue, listVersions, readRescue, readVersion, versionedNames } from "../util/versions";

function savePath(name: string) {
  const clean = cleanName(name);
  return clean ? path.join(SAVES_DIR, clean + ".json") : null;
}

function listSaves(): SaveSummary[] {
  if (!fs.existsSync(SAVES_DIR)) return [];
  const sync = saveSyncInfo();
  return fs.readdirSync(SAVES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.slice(0, -5), mtime: fs.statSync(path.join(SAVES_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .map(({ name, mtime }) => ({ name, savedAt: mtime.toISOString(), ...(sync.synced.has(name) ? { synced: true } : {}), ...(sync.updated[name] ? { syncAt: sync.updated[name] } : {}) }));
}

export async function handleSaves(req: Req, res: Res, name: string | undefined) {
  if (req.method === "GET" && !name) return sendJson(res, 200, listSaves());
  const file = name && savePath(name);
  if (!file) return sendJson(res, 400, { error: "Give the save a name (letters, numbers, spaces, - or _)." });
  if (req.method === "GET") {
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: "No such save" });
    return sendJson(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    try { JSON.parse(body); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    // Sync wrote a newer version from Drive into this save after the page loaded it: the page keeps its changes as a copy
    // and reloads, rather than writing over the other person's changes.
    if (staleWrite(path.basename(file, ".json"), req.headers["x-sync-seen"])) return sendJson(res, 409, { error: "This trip was just updated from Drive.", syncUpdated: true });
    fs.mkdirSync(SAVES_DIR, { recursive: true });
    // What the save held until now is kept first (a save made by hand always keeps one; a trip updated by itself, one every 10 minutes).
    keepVersion(SAVES_DIR, path.basename(file, ".json"), file, req.headers["x-keep-version"] === "1");
    fs.writeFileSync(file, body);
    afterSave(path.basename(file, ".json"));
    return sendJson(res, 200, { name: path.basename(file, ".json") });
  }
  if (req.method === "DELETE") {
    // A deleted trip stays in its history (the last version), so deleting by mistake can be undone.
    if (fs.existsSync(file)) { beforeDelete(path.basename(file, ".json")); keepVersion(SAVES_DIR, path.basename(file, ".json"), file, true); fs.unlinkSync(file); }
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(405).end();
}

/** Earlier versions of a saved trip: "GET /api/saves/<name>/history" lists them, ".../history/<id>" is one. */
export async function handleHistory(req: Req, res: Res, name: string, id?: string) {
  const clean = savePath(name) && path.basename(savePath(name)!, ".json");
  if (!clean) return sendJson(res, 400, { error: "No such save." });
  if (req.method !== "GET") return res.writeHead(405).end();
  if (!id) return sendJson(res, 200, listVersions(SAVES_DIR, clean));
  const text = readVersion(SAVES_DIR, clean, id);
  if (text == null) return sendJson(res, 404, { error: "No such version." });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(text);
}

/** Copies of the trip on screen from before it was replaced: "POST /api/rescue" keeps one, "GET /api/rescue" lists them. */
export async function handleRescue(req: Req, res: Res, id?: string) {
  if (req.method === "POST" && !id) {
    const body = await readJson(req);
    return sendJson(res, 200, { kept: keepRescue(SAVES_DIR, body?.state, SAVES_DIR) });
  }
  if (req.method === "GET" && !id) return sendJson(res, 200, { copies: listRescue(SAVES_DIR), versioned: versionedNames(SAVES_DIR) });
  if (req.method === "GET" && id) {
    const text = readRescue(SAVES_DIR, id);
    if (text == null) return sendJson(res, 404, { error: "No such copy." });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(text);
    return;
  }
  res.writeHead(405).end();
}
