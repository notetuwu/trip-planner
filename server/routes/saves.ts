// Saved trips: saves/<name>.json, written and read as-is.
import fs from "node:fs";
import path from "node:path";
import type { SaveSummary } from "../../shared/types";
import { SAVES_DIR, cleanName } from "../config";
import { type Req, type Res, readBody, readJson, sendJson } from "../util/http";
import { afterSave, beforeDelete, editor, pageWrite, saveSyncInfo } from "../sync/sync";
import { joinLogs, logChanges, manyDays, partBefore, stamp } from "../../shared/edits";
import { keepPart, setPartAfter, keepRescue, keepVersion, listRescue, listVersions, readPart, readRescue, readVersion, versionBefore, versionedNames } from "../util/versions";

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
    // Sync wrote a newer version from Drive into this save after the page loaded it: the page's changes and Drive's are
    // joined (the page then shows the result), or when they clash the page keeps its changes as a copy and reloads,
    // rather than writing over the other person's changes.
    const w = pageWrite(path.basename(file, ".json"), req.headers["x-sync-seen"], body);
    if ("stale" in w) return sendJson(res, 409, { error: "This trip was just updated from Drive.", syncUpdated: true, clashes: w.clashes });
    fs.mkdirSync(SAVES_DIR, { recursive: true });
    // Who changed which part, and when (shown on trips several people work on): the parts that differ from the save.
    const next = JSON.parse("merged" in w ? w.merged : body);
    if (next && typeof next === "object" && !Array.isArray(next)) {
      let prev: any = null;
      try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* a new save */ }
      // (Another trip saved over this name: what it had says nothing about this one.)
      if (prev && prev.sync?.id !== next.sync?.id) prev = null;
      const who = editor(), at = Date.now(), edits = stamp(prev, next, who, at);
      if (edits) next.edits = edits; else delete next.edits;
      // And the history of changes (Changes, and placing photos → History).
      const log = prev ? logChanges(prev, next, who, at) : joinLogs(next.log);
      if (log.length) next.log = log; else delete next.log;
      // What each changed part held until now, so that one change can be put back later (Changes → Put back).
      // And what it holds now, to show exactly what the change did (a change that goes on keeps its first "before").
      if (prev) for (const c of log) if (c.at === at && c.was) {
        const whole = manyDays(c), after = partBefore(next, c.key, whole).value, save = path.basename(file, ".json");
        if (c.was === String(at)) keepPart(SAVES_DIR, save, c.was, c.key, { ...partBefore(prev, c.key, whole), after });
        else setPartAfter(SAVES_DIR, save, c.was, c.key, after, whole);
      }
    }
    // What the save held until now is kept first (a save made by hand always keeps one; a trip updated by itself, one every 10 minutes).
    keepVersion(SAVES_DIR, path.basename(file, ".json"), file, req.headers["x-keep-version"] === "1");
    fs.writeFileSync(file, JSON.stringify(next));
    afterSave(path.basename(file, ".json"));
    return sendJson(res, 200, { name: path.basename(file, ".json"), edits: next?.edits || null, log: next?.log || null, ...("merged" in w ? { merged: true, syncAt: w.at } : {}) });
  }
  if (req.method === "DELETE") {
    // A deleted trip stays in its history (the last version), so deleting by mistake can be undone.
    if (fs.existsSync(file)) { beforeDelete(path.basename(file, ".json")); keepVersion(SAVES_DIR, path.basename(file, ".json"), file, true); fs.unlinkSync(file); }
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(405).end();
}

/** Earlier versions of a saved trip: "GET /api/saves/<name>/history" lists them, ".../history/<id>" is one. */
export async function handleHistory(req: Req, res: Res, name: string, id?: string, query?: URLSearchParams) {
  const clean = savePath(name) && path.basename(savePath(name)!, ".json");
  if (!clean) return sendJson(res, 400, { error: "No such save." });
  if (req.method !== "GET") return res.writeHead(405).end();
  // ".../history/before?key=&was=&at=&whole=": what a part held before a change. Exactly, when this computer kept it;
  // else from the newest version of the trip from before the change (`savedAt` says how old that is).
  if (id === "before") {
    const none = () => sendJson(res, 404, { error: "What it held before this change wasn't kept." });
    const key = String(query?.get("key") || "").slice(0, 200), was = String(query?.get("was") || ""), at = Number(query?.get("at"));
    if (!key) return none();
    const kept = readPart(SAVES_DIR, clean, was, key);
    if (kept != null) { try { return sendJson(res, 200, { ...JSON.parse(kept), exact: true }); } catch { /* unreadable: from a version */ } }
    // ("exact=1": only what was kept for this very change, for showing what it did.)
    const old = Number.isFinite(at) && query?.get("exact") !== "1" ? versionBefore(SAVES_DIR, clean, at) : null;
    if (!old) return none();
    try { return sendJson(res, 200, { ...partBefore(JSON.parse(old.text), key, query?.get("whole") === "1"), exact: false, savedAt: old.savedAt }); } catch { return none(); }
  }
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
