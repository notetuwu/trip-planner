// Saved trips: saves/<name>.json, written and read as-is.
import fs from "node:fs";
import path from "node:path";
import type { SaveSummary } from "../../shared/types";
import { SAVES_DIR, cleanName } from "../config";
import { type Req, type Res, readBody, sendJson } from "../util/http";

function savePath(name: string) {
  const clean = cleanName(name);
  return clean ? path.join(SAVES_DIR, clean + ".json") : null;
}

function listSaves(): SaveSummary[] {
  if (!fs.existsSync(SAVES_DIR)) return [];
  return fs.readdirSync(SAVES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f.slice(0, -5), mtime: fs.statSync(path.join(SAVES_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .map(({ name, mtime }) => ({ name, savedAt: mtime.toISOString() }));
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
