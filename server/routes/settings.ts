// GET /api/settings: how the app opens (own window or browser tab). POST: change it, and open the app the new way now.
import { PACKAGED, PORT, ROOT } from "../config";
import { appBrowser, openWindow } from "../launcher";
import { readSettings, writeSettings } from "../settings";
import { type Req, type Res, readJson, sendJson } from "../util/http";

export async function handleSettings(req: Req, res: Res) {
  if (req.method === "POST") {
    const body = await readJson(req);
    const s = writeSettings({ window: body?.window });
    if (body?.reopen && PACKAGED) openWindow(`http://localhost:${PORT}`, ROOT, s.window);
    sendJson(res, 200, s);
    return;
  }
  sendJson(res, 200, { ...readSettings(), packaged: PACKAGED, appWindow: !!appBrowser() });
}
