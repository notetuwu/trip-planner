// Where a sync folder is: Google Drive (google.ts) or a folder on this computer (local-store.ts; also a network drive,
// or a folder OneDrive, Dropbox or iCloud keep in step here). The sync (sync.ts) asks this, by the folder's or file's id.
import os from "node:os";
import crypto from "node:crypto";
import * as g from "./google";
import * as local from "./local-store";

export { isLocalId } from "./local-store";
export const isDriveFolder = (id: string) => !local.isLocalId(id);

export const folderInfo = (id: string) => (local.isLocalId(id) ? Promise.resolve(local.folderInfo(id)) : g.folderInfo(id));
export const listTripFiles = (folder: string) => (local.isLocalId(folder) ? Promise.resolve(local.listTripFiles(folder)) : g.listTripFiles(folder));
export const fileMeta = (id: string) => (local.isLocalId(id) ? Promise.resolve(local.fileMeta(id)) : g.fileMeta(id));
export const download = (id: string) => (local.isLocalId(id) ? Promise.resolve(local.download(id)) : g.download(id));
export const upload = (o: { id?: string; folder?: string; name: string; text: string; properties?: Record<string, string> }) =>
  (local.isLocalId(o.id || o.folder) ? Promise.resolve(local.upload(o)) : g.upload(o));

/** A file name for what's kept about a file (its last-agreed copy, its download): a Drive id as it is, a path hashed. */
export const fileKey = (id: string) => (g.isDriveId(id) ? id : `l-${crypto.createHash("sha1").update(id).digest("hex")}`);

/** Who this is: the Google account when signed in, and this computer's user (for folders on this computer or a shared
 *  drive, which need no Google account). A trip shared by any of these is this person's. */
export function me(): { id: string; name: string; ids: string[] } {
  const acc = g.account();
  let user = "you";
  try { user = os.userInfo().username; } catch { /* unknown */ }
  const here = `${user}@${os.hostname()}`;
  return acc.signedIn ? { id: acc.email, name: acc.name || acc.email, ids: [acc.email, here] } : { id: here, name: user, ids: [here] };
}
/** Whether Drive can be used now. */
export const driveReady = () => !!g.client() && g.account().signedIn;
