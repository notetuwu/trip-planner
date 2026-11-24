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
    // A window may only replace the copy when it has seen the latest: `base` is the time stamp it last sent or took. Someone
    // saved since (so it's out of date: a tab left open from earlier) and it's refused, and takes the newer one instead.
    // A page from before this rule (a tab left open) doesn't say what it has seen, so it can't tell it's out of date: once the
    // computer has a copy, it's not allowed to replace it (it would send its old trip over the new one, again and again).
    if (read().at > 0 && (typeof body.base !== "number" || body.base < read().at)) { sendJson(res, 200, { conflict: true, at: read().at }); return; }
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
