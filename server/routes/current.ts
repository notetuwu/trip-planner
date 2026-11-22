// The trip that's open, shared by every window and device using this planner (the app window, a browser tab, a phone
// on the home network): each saves it here, and the others pick it up when they're next looked at. Newest wins.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config";
import { type Req, type Res, readJson, sendJson } from "../util/http";

const FILE = path.join(ROOT, "current-trip.json");
let cache: { at: number; state: unknown } | null = null;

function read() {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { cache = { at: 0, state: null }; } }
  return cache!;
}

export async function handleCurrent(req: Req, res: Res) {
  if (req.method === "PUT") {
    const body = await readJson(req);
    const at = Number(body?.at) || 0;
    if (!body?.state || typeof body.state !== "object") { sendJson(res, 400, { error: "No trip" }); return; }
    // An older copy (a window that was asleep) doesn't overwrite a newer one.
    if (at >= read().at) {
      cache = { at, state: body.state };
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cache));
    }
    sendJson(res, 200, { at: read().at });
    return;
  }
  // ?since=<at>: only send the trip when it's newer than what the page has.
  const since = Number(new URL(req.url || "/", "http://x").searchParams.get("since")) || 0;
  const c = read();
  sendJson(res, 200, c.at > since ? c : { at: c.at });
}
