// Where a sync folder is: Google Drive (google.ts), Dropbox (dropbox.ts), or a folder on this computer (local-store.ts;
// also a network drive, or a folder OneDrive or iCloud keep in step here). The sync (sync.ts) asks this, by the folder's
// or file's id: "local:<path>", "dropbox:id:…", or a bare Drive id.
import os from "node:os";
import crypto from "node:crypto";
import * as box from "./dropbox";
import * as g from "./google";
import * as local from "./local-store";

export { isLocalId } from "./local-store";
export type Provider = "local" | "dropbox" | "drive";
export const providerOf = (id: string | undefined): Provider => (local.isLocalId(id) ? "local" : String(id || "").startsWith(box.PREFIX) ? "dropbox" : "drive");
export const isDriveFolder = (id: string) => providerOf(id) === "drive";

/** Whether a folder's service can be used now (signed in), and what to do when it can't. */
export const ready = (p: Provider) => (p === "local" ? true : p === "dropbox" ? box.ready() : driveReady());
export const notReady = (p: Provider) => (p === "dropbox" ? "Sign in to Dropbox (Settings → Accounts) to sync with this folder." : "Sign in with Google (Settings → Accounts) to sync with this folder.");

const pick = <T>(id: string | undefined, f: { local: () => T; dropbox: () => T; drive: () => T }) => f[providerOf(id)]();
export const folderInfo = (id: string) => pick(id, { local: () => Promise.resolve(local.folderInfo(id)), dropbox: () => box.folderInfo(id), drive: () => g.folderInfo(id) });
export const listTripFiles = (id: string) => pick(id, { local: () => Promise.resolve(local.listTripFiles(id)), dropbox: () => box.listTripFiles(id), drive: () => g.listTripFiles(id) });
export const fileMeta = (id: string) => pick(id, { local: () => Promise.resolve(local.fileMeta(id)), dropbox: () => box.fileMeta(id), drive: () => g.fileMeta(id) });
export const download = (id: string) => pick(id, { local: () => Promise.resolve(local.download(id)), dropbox: () => box.download(id), drive: () => g.download(id) });
export const upload = (o: { id?: string; folder?: string; name: string; text: string; properties?: Record<string, string> }) =>
  pick(o.id || o.folder, { local: () => Promise.resolve(local.upload(o)), dropbox: () => box.upload(o), drive: () => g.upload(o) });

/** A file name for what's kept about a file (its last-agreed copy, its download): a Drive id as it is, others hashed. */
export const fileKey = (id: string) => (g.isDriveId(id) ? id : `l-${crypto.createHash("sha1").update(id).digest("hex")}`);

/** Who this is: the Google account and the Dropbox account when signed in, and this computer's user (for folders on this
 *  computer or a shared drive, which need no account). A trip shared by any of these is this person's. */
export function me(): { id: string; name: string; ids: string[] } {
  const acc = g.account(), dbx = box.account();
  let user = "you";
  try { user = os.userInfo().username; } catch { /* unknown */ }
  const here = `${user}@${os.hostname()}`;
  const ids = [...(acc.signedIn && acc.email ? [acc.email] : []), ...(dbx.signedIn && dbx.email ? [dbx.email] : []), here];
  const main = acc.signedIn && acc.email ? { id: acc.email, name: acc.name || acc.email } : dbx.signedIn && dbx.email ? { id: dbx.email, name: dbx.name || dbx.email } : { id: here, name: user };
  return { ...main, ids: [...new Set(ids)] };
}
/** Whether Drive can be used now. */
export const driveReady = () => !!g.client() && g.account().signedIn && g.account().drive !== false;
