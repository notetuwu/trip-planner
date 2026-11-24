// GET /api/settings: how the app opens (own window or browser tab), the local models' context size, where the data
// is. POST: change them (and open the app the new way now, if asked). /api/lan: phone access, its status, start/stop.
import { PACKAGED, PORT, ROOT, VERSION } from "../config";
import { lanStatus, startLan, stopLan } from "../lan";
import { appBrowser, openWindow } from "../launcher";
import { newToken, readSettings, writeSettings } from "../settings";
import { type Req, type Res, readJson, sendJson } from "../util/http";

/** The settings as the page sees them (never the phone link's secret, nor the Brave key: only whether it's set). */
const view = () => {
  const { lanToken: _secret, braveKey, geoapifyKey, ...s } = readSettings();
  return { ...s, braveKeySet: !!(braveKey || process.env.BRAVE_API_KEY), geoapifyKeySet: !!(geoapifyKey || process.env.GEOAPIFY_API_KEY), packaged: PACKAGED, appWindow: !!appBrowser(), dataDir: ROOT, version: VERSION };
};

export async function handleSettings(req: Req, res: Res) {
  if (req.method === "POST") {
    const body = await readJson(req);
    const s = writeSettings({ window: body?.window, numCtx: body?.numCtx, checkUpdates: body?.checkUpdates, braveKey: body?.braveKey, geoapifyKey: body?.geoapifyKey, searxngUrl: body?.searxngUrl, quickstartSeen: body?.quickstartSeen, tune: body?.tune && typeof body.tune === "object" ? body.tune : undefined, app: body?.app && typeof body.app === "object" ? body.app : undefined });
    if (body?.reopen && PACKAGED) openWindow(`http://localhost:${PORT}`, ROOT, s.window);
    sendJson(res, 200, view());
    return;
  }
  sendJson(res, 200, view());
}

export async function handleLan(req: Req, res: Res, path: string) {
  if (req.method === "POST" && path === "/api/lan") {
    const body = await readJson(req);
    const on = !!body?.on;
    writeSettings({ lan: on });
    sendJson(res, 200, on ? await startLan() : await stopLan());
    return;
  }
  // A new link: phones with the old one have to open the new one.
  if (req.method === "POST" && path === "/api/lan/new-link") { writeSettings({ lanToken: newToken() }); sendJson(res, 200, lanStatus()); return; }
  sendJson(res, 200, lanStatus());
}
