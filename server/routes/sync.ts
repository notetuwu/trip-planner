// /api/sync: signing in with Google, the sync folders, which folders each trip syncs to, clashes, and the trips in the
// folders (for Your trips). Only for this computer: a phone on the home network can't reach it (lan.ts), and the Google
// token never leaves the server.
import type { RemoteTripCard } from "../../shared/types";
import { errMsg } from "../config";
import { placesByName, tripCard } from "./trips";
import * as box from "../sync/dropbox";
import { browse, clientShown, createFolder, parseClient, setClient, startSignIn } from "../sync/google";
import { addFolder, checkTrip, dismissNotices, newFolder, openRemote, remoteTrips, removeFolder, renameFolder, resolve, runSync, setTripSync, signOut, status, tripName } from "../sync/sync";
import { type Req, type Res, readJson, sendJson } from "../util/http";
import { fsCheck } from "../util/fs-browse";
import { KIND_LABEL, folderKind } from "../util/folder-kind";

export async function handleSync(req: Req, res: Res, path: string) {
  const { method } = req;
  try {
    if (method === "GET" && path === "/api/sync") return sendJson(res, 200, status());
    if (method === "POST" && path === "/api/sync/signin") return sendJson(res, 200, { url: await startSignIn() });
    if (method === "POST" && path === "/api/sync/signout") { await signOut(); return sendJson(res, 200, status()); }
    // Look at the folders now (Your trips opened, or "Sync now"); answers when it's done.
    if (method === "POST" && path === "/api/sync/now") { await runSync(); return sendJson(res, 200, status()); }
    if (method === "GET" && path === "/api/sync/check") return sendJson(res, 200, await checkTrip(new URL(req.url || "/", "http://x").searchParams.get("name") || ""));
    // The Drive folders to pick from: "?in=root" (My Drive), "shared" (shared with me), "drives" (shared drives) or a folder's id.
    if (method === "GET" && path === "/api/sync/browse") return sendJson(res, 200, await browse(new URL(req.url || "/", "http://x").searchParams.get("in") || "root"));
    // A new folder in the folder browser ("parent": "root" or a folder's id).
    if (method === "POST" && path === "/api/sync/mkdir") { const b = await readJson(req); return sendJson(res, 200, await createFolder(String(b?.name || ""), String(b?.parent || "root"))); }
    // The person's own Google client, to show and change in Settings → Accounts (this computer only; never a phone, see lan.ts).
    if (method === "GET" && path === "/api/sync/client") return sendJson(res, 200, clientShown());
    // What kind of folder a path on this computer is (a cloud app's, a network drive…), before it's added.
    if (method === "GET" && path === "/api/sync/kind") {
      const p = fsCheck(new URL(req.url || "/", "http://x").searchParams.get("path") || "").path, kind = await folderKind(p);
      return sendJson(res, 200, { path: p, kind, label: KIND_LABEL[kind], shared: kind !== "local" });
    }
    // Dropbox: the app key, signing in and out, and its folders for the folder browser.
    if (path.startsWith("/api/sync/dropbox/")) {
      const sub = path.slice("/api/sync/dropbox/".length), q = new URL(req.url || "/", "http://x").searchParams;
      if (method === "GET" && sub === "key") return sendJson(res, 200, { key: box.keyFrom() === "app" ? box.appKey() : "" });
      if (method === "GET" && sub === "browse") return sendJson(res, 200, await box.browse(q.get("in") || "root"));
      const b = method === "POST" ? await readJson(req) : null;
      if (method === "POST" && sub === "key") { await box.setAppKey(String(b?.key || "")); return sendJson(res, 200, status()); }
      if (method === "POST" && sub === "signin") return sendJson(res, 200, { url: await box.startSignIn() });
      if (method === "POST" && sub === "signout") { await box.signOut(); return sendJson(res, 200, status()); }
      if (method === "POST" && sub === "mkdir") return sendJson(res, 200, await box.createFolder(String(b?.name || ""), String(b?.parent || "root")));
      return sendJson(res, 404, { error: "Not found" });
    }
    if (method === "POST" && path === "/api/sync/notices") { dismissNotices(); return sendJson(res, 200, status()); }
    if (method === "GET" && path === "/api/sync/remote") {
      const where = placesByName();
      const cards: RemoteTripCard[] = remoteTrips().map(({ folder, file, trip }) => ({
        ...tripCard(tripName(file.name), file.at || new Date(0).toISOString(), trip, where),
        folder, fileId: file.id, by: file.by,
        share: trip?.sync && typeof trip.sync === "object" ? { id: String(trip.sync.id || ""), owner: String(trip.sync.owner || ""), ownerName: String(trip.sync.ownerName || ""), mode: trip.sync.mode === "view" ? "view" : "edit" } : null,
      }));
      return sendJson(res, 200, cards);
    }
    const body = method === "POST" ? await readJson(req) : null;
    // The person's own Google client ID and secret.
    if (method === "POST" && path === "/api/sync/client") { await setClient(parseClient(String(body?.id || ""), String(body?.secret || ""))); return sendJson(res, 200, status()); }
    if (method === "POST" && path === "/api/sync/client/remove") { await setClient(null); return sendJson(res, 200, status()); }
    if (method === "POST" && path === "/api/sync/folders") {
      const f = body?.create ? await newFolder(String(body?.name || ""), String(body?.label || "")) : await addFolder(String(body?.link || ""), String(body?.label || ""));
      return sendJson(res, 200, { folder: f, status: status() });
    }
    if (method === "POST" && path === "/api/sync/folders/rename") { renameFolder(String(body?.id || ""), String(body?.label || "")); return sendJson(res, 200, status()); }
    if (method === "POST" && path === "/api/sync/folders/remove") { removeFolder(String(body?.id || "")); return sendJson(res, 200, status()); }
    if (method === "POST" && path === "/api/sync/trip") {
      const mode = body?.mode === "view" || body?.mode === "edit" ? body.mode : undefined;
      const r = await setTripSync(String(body?.name || ""), Array.isArray(body?.folders) ? body.folders.map(String) : [], mode);
      return sendJson(res, 200, { ...r, status: status() });
    }
    if (method === "POST" && path === "/api/sync/resolve") {
      if (body?.keep !== "mine" && body?.keep !== "theirs") return sendJson(res, 400, { error: "Keep which?" });
      await resolve(String(body?.name || ""), String(body?.folder || ""), body.keep);
      return sendJson(res, 200, status());
    }
    if (method === "POST" && path === "/api/sync/open") return sendJson(res, 200, await openRemote(String(body?.folder || ""), String(body?.fileId || "")));
    return sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    return sendJson(res, 400, { error: errMsg(e) });
  }
}
