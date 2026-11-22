// /api/update: is there a newer version (GET; the answer kept from the last check, see update/check.ts), install it
// (POST), how far the install is (GET /status), what Settings → Updates shows (GET /state), and Check now (POST /check).
import { errMsg } from "../config";
import { checkForUpdate, updateState } from "../update/check";
import { startUpdate, status } from "../update/install";
import { type Req, type Res, sendJson } from "../util/http";

export async function handleUpdate(req: Req, res: Res, path: string) {
  try {
    if (path === "/api/update/status") return sendJson(res, 200, status);
    if (path === "/api/update/state") return sendJson(res, 200, updateState());
    if (path === "/api/update/check" && req.method === "POST") {
      await checkForUpdate(true).catch(() => null); // the error is in the state
      return sendJson(res, 200, updateState());
    }
    if (req.method === "POST") return sendJson(res, 200, await startUpdate());
    sendJson(res, 200, (await checkForUpdate()) || { newer: false });
  } catch (e) {
    sendJson(res, req.method === "POST" ? 400 : 200, { newer: false, error: errMsg(e) });
  }
}
