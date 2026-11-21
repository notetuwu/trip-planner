// /api/update: is there a newer version (GET), install it (POST), and how far the install is (GET /status).
import { errMsg } from "../config";
import { checkForUpdate } from "../update/check";
import { startUpdate, status } from "../update/install";
import { type Req, type Res, sendJson } from "../util/http";

export async function handleUpdate(req: Req, res: Res, path: string) {
  try {
    if (path === "/api/update/status") return sendJson(res, 200, status);
    if (req.method === "POST") return sendJson(res, 200, await startUpdate());
    sendJson(res, 200, (await checkForUpdate()) || { newer: false });
  } catch (e) {
    sendJson(res, req.method === "POST" ? 400 : 200, { newer: false, error: errMsg(e) });
  }
}
