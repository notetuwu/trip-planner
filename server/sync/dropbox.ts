// Dropbox, for syncing trips and showing photos (geo/dropbox-photos.ts), set up in Settings → Accounts, like Google Drive (google.ts): each person registers their own free
// Dropbox app and enters its app key; signing in uses Dropbox's flow for desktop apps (PKCE, so no secret), and the
// browser comes back to a small one-off server on this computer at a fixed address (Dropbox only accepts the exact
// redirect address registered with the app: http://localhost:47618/).
//
// Safety: the token is kept in the data folder (sync/dropbox-auth.json) and never sent to the page, a phone, a trip or a
// folder. Only the sync and photo folders are used, and nothing is ever deleted.
// Ids: a Dropbox item is "dropbox:" and its Dropbox id ("dropbox:id:a4ayc_80_OEAAAAAAAAAXw").
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { USER_AGENT, errMsg } from "../config";
import { openInBrowser } from "../launcher";
import type { DriveFile } from "./google";
import { SYNC_DIR } from "./google";

export const PREFIX = "dropbox:";
export const REDIRECT_PORT = 47618;
export const REDIRECT = `http://localhost:${REDIRECT_PORT}/`;
export const SCOPES = ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write", "sharing.read", "sharing.write"];
const API = "https://api.dropboxapi.com", CONTENT = "https://content.dropboxapi.com";
const CLIENT_FILE = () => path.join(SYNC_DIR, "dropbox-client.json"), AUTH_FILE = () => path.join(SYNC_DIR, "dropbox-auth.json");
const MAX_TRIP_BYTES = 25 * 1024 * 1024;

export const isDropboxId = (id: unknown): id is string => typeof id === "string" && id.startsWith(PREFIX) && /^id:[\w-]{6,}$/.test(id.slice(PREFIX.length));
const raw = (id: string) => id.slice(PREFIX.length);

// ---- The app key and the sign-in ------------------------------------------------------------------------------------------
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const writeJson = (file: string, v: unknown) => { fs.mkdirSync(SYNC_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 }); };

/** The person's own Dropbox app key: from Settings → Accounts, else DROPBOX_APP_KEY. */
export function appKey(): string {
  return (readJson<{ key?: string }>(CLIENT_FILE())?.key || process.env.DROPBOX_APP_KEY || "").trim();
}
export const keyFrom = (): "app" | "env" | "" => (readJson<{ key?: string }>(CLIENT_FILE())?.key ? "app" : process.env.DROPBOX_APP_KEY ? "env" : "");

/** Saves the app key entered in Settings (empty removes it). Another key signs out. */
export async function setAppKey(key: string) {
  const k = String(key || "").trim();
  if (k && !/^[a-z0-9]{8,32}$/i.test(k)) throw new Error("That doesn't look like a Dropbox app key (letters and digits, from the app's Settings page in the App Console).");
  const before = appKey();
  if (k) writeJson(CLIENT_FILE(), { key: k }); else { try { fs.unlinkSync(CLIENT_FILE()); } catch { /* none */ } }
  if (before !== appKey()) await signOut();
}

interface Auth { refresh: string; email: string; name: string; accountId: string; at: number; expired?: boolean }
const readAuth = () => { const a = readJson<Auth>(AUTH_FILE()); return a?.refresh ? a : null; };
const writeAuth = (a: Auth | null) => { if (a) writeJson(AUTH_FILE(), a); else { try { fs.unlinkSync(AUTH_FILE()); } catch { /* none */ } } };

export function account() {
  const a = readAuth();
  return { signedIn: !!a && !a.expired, expired: !!a?.expired, email: a?.email || "", name: a?.name || "" };
}
export const ready = () => !!appKey() && account().signedIn;

let access: { token: string; until: number } | null = null;
let pending: { servers: http.Server[]; timer: NodeJS.Timeout } | null = null;
let signInError = "";
export const signInState = () => ({ signingIn: !!pending, signInError });

function stopPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  for (const s of pending.servers) { s.close(); s.closeAllConnections?.(); }
  pending = null;
}

const b64url = (b: Buffer) => b.toString("base64url");
const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto;color:#222"><h2>${title}</h2><p>${text}</p></body>`;
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function token(params: Record<string, string>) {
  const res = await fetch(`${API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as any };
}

/** Starts signing in: Dropbox's page in the default browser, which comes back to http://localhost:47618/. */
export async function startSignIn(): Promise<string> {
  const key = appKey();
  if (!key) throw new Error("Add your Dropbox app key first (Settings → Accounts).");
  stopPending();
  signInError = "";
  const state = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || "/", REDIRECT);
    if (url.pathname !== "/" || req.method !== "GET") { res.writeHead(404).end(); return; }
    const answer = (status: number, title: string, text: string) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); res.end(page(title, text)); };
    if (url.searchParams.get("state") !== state) return answer(400, "That didn't work", "This sign-in page is out of date. Start again from Trip Planner (Settings → Accounts).");
    const done = (error = "") => { signInError = error; stopPending(); };
    const err = url.searchParams.get("error");
    if (err) {
      answer(200, "Not signed in", "Dropbox didn't sign you in, so nothing changed. You can close this tab.");
      return done(err === "access_denied" ? "Signing in was cancelled." : `Dropbox said: ${url.searchParams.get("error_description") || err}`);
    }
    try {
      const { ok, json } = await token({ code: String(url.searchParams.get("code") || ""), grant_type: "authorization_code", client_id: key, code_verifier: verifier, redirect_uri: REDIRECT });
      if (!ok || !json.access_token) throw new Error(`Dropbox refused the sign-in: ${json.error_description || json.error || "no token"}`);
      if (!json.refresh_token) throw new Error("Dropbox didn't let the app stay signed in. Sign in again.");
      access = { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
      const me = await rpc("/2/users/get_current_account", null);
      writeAuth({ refresh: json.refresh_token, email: String(me?.email || ""), name: String(me?.name?.display_name || ""), accountId: String(me?.account_id || json.account_id || ""), at: Date.now() });
      answer(200, "Signed in", "Trip Planner can sync your trips with Dropbox now. You can close this tab and go back to the app.");
      done();
    } catch (e) { answer(200, "That didn't work", escHtml(errMsg(e))); done(errMsg(e)); }
  };
  // "localhost" may be the IPv4 or the IPv6 address, depending on the browser: both answer (only on this computer).
  const servers: http.Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const s = http.createServer(onRequest);
    const ok = await new Promise<boolean>((resolve) => { s.once("error", () => resolve(false)); s.listen(REDIRECT_PORT, host, () => resolve(true)); });
    if (ok) servers.push(s);
  }
  if (!servers.length) throw new Error(`Port ${REDIRECT_PORT} is in use, so Dropbox can't send you back to the app. Close what uses it and try again.`);
  pending = { servers, timer: setTimeout(() => { signInError = "Signing in took too long. Try again."; stopPending(); }, 10 * 60_000) };
  const url = `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({
    client_id: key, response_type: "code", redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: "S256",
    token_access_type: "offline", scope: SCOPES.join(" "),
  })}`;
  openInBrowser(url);
  return url;
}

/** Signs out: Dropbox is told to end the app's access, and the token is deleted here. */
export async function signOut() {
  stopPending();
  const had = !!readAuth();
  if (had) await fetch(`${API}/2/auth/token/revoke`, { method: "POST", headers: { Authorization: `Bearer ${await accessToken().catch(() => "")}`, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }).catch(() => {});
  access = null;
  writeAuth(null);
}

async function accessToken(): Promise<string> {
  if (access && access.until > Date.now() + 60_000) return access.token;
  const a = readAuth(), key = appKey();
  if (!a || a.expired || !key) throw new Error("Not signed in to Dropbox.");
  // PKCE: a refresh needs the app key, not a secret.
  const { ok, json } = await token({ grant_type: "refresh_token", refresh_token: a.refresh, client_id: key });
  if (!ok) {
    if (json.error === "invalid_grant") { writeAuth({ ...a, refresh: "-", expired: true }); throw new Error("Dropbox signed this computer out. Sign in again in Settings → Accounts."); }
    throw new Error(`Dropbox: ${json.error_description || json.error || "couldn't sign in"}`);
  }
  access = { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return access.token;
}

// ---- Dropbox's API ---------------------------------------------------------------------------------------------------------
/** What Dropbox said, in words that say what to do. */
function explain(status: number, body: any): string {
  const s = String(body?.error_summary || body?.error?.[".tag"] || body || "");
  if (/missing_scope/.test(s)) return "The Dropbox app is missing a permission: tick all those in the guide (Permissions tab), press Submit, then sign out and in again.";
  if (/not_found/.test(s)) return "Dropbox can't find it (deleted, or not in this Dropbox).";
  if (/no_write_permission|insufficient_space|read_only/.test(s)) return /space/.test(s) ? "This Dropbox is full." : "You can only view this folder in Dropbox.";
  if (status === 429 || /too_many/.test(s)) return "Dropbox asks to slow down for a moment. It tries again later.";
  return `Dropbox answered ${status}${s ? `: ${s.slice(0, 160)}` : ""}`;
}

async function call(url: string, init: RequestInit, again = true): Promise<Response> {
  const t = await accessToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}`, "User-Agent": USER_AGENT }, signal: init.signal || AbortSignal.timeout(60000) });
  if (res.status === 401 && again) { access = null; return call(url, init, false); }
  return res;
}
/** An RPC call (JSON in, JSON out). */
async function rpc(endpoint: string, arg: unknown): Promise<any> {
  const res = await call(`${API}${endpoint}`, arg === null ? { method: "POST" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arg) });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = text; }
  if (!res.ok) { const e = new Error(explain(res.status, json)) as Error & { summary?: string }; e.summary = String(json?.error_summary || ""); throw e; }
  return json;
}
/** Dropbox wants non-ASCII characters in its header escaped. */
const headerArg = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

interface Meta { ".tag": "file" | "folder" | "deleted"; id: string; name: string; path_lower?: string; path_display?: string; rev?: string; content_hash?: string; server_modified?: string; size?: number; sharing_info?: { read_only?: boolean }; shared_folder_id?: string }

function asFile(m: Meta): DriveFile {
  return { id: PREFIX + m.id, name: m.name, md5Checksum: m.content_hash || m.rev || "", modifiedTime: m.server_modified || "", size: m.size != null ? String(m.size) : undefined, capabilities: { canEdit: !m.sharing_info?.read_only } };
}

export async function folderInfo(id: string): Promise<{ id: string; name: string; canWrite: boolean }> {
  if (!isDropboxId(id)) throw new Error("Not a Dropbox folder.");
  const m: Meta = await rpc("/2/files/get_metadata", { path: raw(id) });
  if (m[".tag"] !== "folder") throw new Error("That's a file, not a folder.");
  return { id: PREFIX + m.id, name: m.name, canWrite: !m.sharing_info?.read_only };
}

/** The signed-in account's profile picture (none unless one was set). */
export async function myPicture(): Promise<{ email?: string; url?: string }[]> {
  const me = await rpc("/2/users/get_current_account", null);
  return [{ email: me?.email, url: me?.profile_photo_url }];
}
/** The pictures of the members of a shared folder (or of the shared folder it's in). */
export async function folderPeople(id: string): Promise<{ email?: string; url?: string }[]> {
  const m = await rpc("/2/files/get_metadata", { path: raw(id) });
  const shared = m?.sharing_info?.shared_folder_id || m?.sharing_info?.parent_shared_folder_id;
  if (!shared) return [];
  const members = await rpc("/2/sharing/list_folder_members", { shared_folder_id: shared, limit: 100 });
  const ids = (members?.users || []).map((u: any) => u.user?.account_id).filter(Boolean);
  if (!ids.length) return [];
  const accounts = await rpc("/2/users/get_account_batch", { account_ids: ids });
  return (Array.isArray(accounts) ? accounts : []).map((a: any) => ({ email: a.email, url: a.profile_photo_url }));
}

async function listAll(pathArg: string): Promise<Meta[]> {
  const out: Meta[] = [];
  let r = await rpc("/2/files/list_folder", { path: pathArg, include_mounted_folders: true, limit: 1000 });
  out.push(...r.entries);
  while (r.has_more && out.length < 3000) { r = await rpc("/2/files/list_folder/continue", { cursor: r.cursor }); out.push(...r.entries); }
  return out;
}

/** The trip files (.json) in a folder; `deep`: also in the folders directly inside it (not further down). */
export async function listTripFiles(folder: string, deep = false): Promise<DriveFile[]> {
  if (!isDropboxId(folder)) throw new Error("Not a Dropbox folder.");
  const jsonIn = (all: Meta[]) => all.filter((m) => m[".tag"] === "file" && /\.json$/i.test(m.name) && !(Number(m.size) > MAX_TRIP_BYTES)).map(asFile);
  const top = await listAll(raw(folder)), out = jsonIn(top);
  if (!deep) return out;
  for (const d of top.filter((m) => m[".tag"] === "folder").slice(0, 200)) out.push(...jsonIn(await listAll(raw(PREFIX + d.id))).map((f) => ({ ...f, sub: d.name, subId: PREFIX + d.id })));
  return out;
}

export async function listFolders(folder: string): Promise<{ id: string; name: string; canWrite: boolean }[]> {
  if (!isDropboxId(folder)) throw new Error("Not a Dropbox folder.");
  return (await listAll(raw(folder))).filter((m) => m[".tag"] === "folder").slice(0, 200).map((m) => ({ id: PREFIX + m.id, name: m.name, canWrite: !m.sharing_info?.read_only }));
}

export async function fileMeta(id: string): Promise<DriveFile & { trashed?: boolean }> {
  try { return asFile(await rpc("/2/files/get_metadata", { path: raw(id) })); }
  catch (e) { if (/not_found/.test((e as { summary?: string }).summary || "")) return { id, name: "", md5Checksum: "", trashed: true }; throw e; }
}

export async function download(id: string): Promise<string> {
  const res = await call(`${CONTENT}/2/files/download`, { method: "POST", headers: { "Dropbox-API-Arg": headerArg({ path: raw(id) }) } });
  if (!res.ok) throw new Error(explain(res.status, await res.json().catch(() => ({}))));
  if (Number(res.headers.get("content-length")) > MAX_TRIP_BYTES) throw new Error("That trip file is too big.");
  return res.text();
}

/** Writes a trip file: a new one in `folder` (renamed if the name is taken), or a new version of file `id` (only over the
 *  version it was read as: if someone saved it meanwhile, Dropbox refuses, and the next round sees their change). */
export async function upload(o: { id?: string; folder?: string; name: string; text: string }): Promise<DriveFile> {
  let arg: Record<string, unknown>;
  if (o.id) {
    const m: Meta = await rpc("/2/files/get_metadata", { path: raw(o.id) });
    arg = { path: m.path_lower || raw(o.id), mode: { ".tag": "update", update: m.rev }, autorename: false, mute: true };
  } else {
    const name = o.name.replace(/[\\/:*?"<>|]/g, "").trim() || "Trip.trip.json";
    arg = { path: `${raw(o.folder!)}/${name}`, mode: "add", autorename: true, mute: true };
  }
  const res = await call(`${CONTENT}/2/files/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerArg(arg) }, body: o.text });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, json));
  return asFile(json);
}

/** A new file in a folder (renamed by Dropbox if the name is taken). */
export async function putDoc(folder: string, name: string, data: Buffer): Promise<{ name: string }> {
  const arg = { path: `${raw(folder)}/${name}`, mode: "add", autorename: true, mute: true };
  const res = await call(`${CONTENT}/2/files/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerArg(arg) }, body: new Uint8Array(data) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, json));
  return { name: String(json.name || name) };
}

// ---- Photos (only reading) ----------------------------------------------------------------------------------------------
/** What's directly in a folder; `version` changes when a file's content does. */
export async function folderEntries(id: string): Promise<{ id: string; name: string; folder: boolean; version: string; modified: string; size: number }[]> {
  if (!isDropboxId(id)) throw new Error("Not a Dropbox folder.");
  return (await listAll(raw(id))).filter((m) => m[".tag"] !== "deleted").map((m) => ({ id: PREFIX + m.id, name: m.name, folder: m[".tag"] === "folder", version: m.content_hash || m.rev || "", modified: m.server_modified || "", size: Number(m.size) || 0 }));
}

/** A file as Dropbox sends it, whole or the part in `range` ("bytes=0-99"). */
export async function fileResponse(id: string, range = "", signal?: AbortSignal): Promise<Response> {
  const res = await call(`${CONTENT}/2/files/download`, { method: "POST", headers: { "Dropbox-API-Arg": headerArg({ path: raw(id) }), ...(range ? { Range: range } : {}) }, signal });
  if ((res.ok || res.status === 206) && res.body) return res;
  const e = new Error(explain(res.status, await res.json().catch(() => ({})))) as Error & { retryAfter?: number };
  if (res.status === 429) e.retryAfter = Number(res.headers.get("retry-after")) || 5;
  throw e;
}

/** `len` bytes of a file from `start` (fewer at its end; null past it). */
export async function readRange(id: string, start: number, len: number): Promise<Buffer | null> {
  let res: Response;
  try { res = await fileResponse(id, `bytes=${start}-${start + len - 1}`); }
  catch (e) { if (/answered 416/.test((e as Error).message)) return null; throw e; }
  // A whole file sent instead: only what's asked for is read, then the rest is dropped.
  const chunks: Buffer[] = [], skip = res.status === 206 ? 0 : start;
  let got = 0;
  const reader = res.body!.getReader();
  while (got < skip + len) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); got += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = Buffer.concat(chunks).subarray(skip, skip + len);
  return out.length ? out : null;
}

/** A picture's thumbnail (JPEG) at a size like "w256h256"; null when Dropbox can't make one of it. */
export async function thumbnail(id: string, size: string): Promise<Response | null> {
  const res = await call(`${CONTENT}/2/files/get_thumbnail_v2`, { method: "POST", headers: { "Dropbox-API-Arg": headerArg({ resource: { ".tag": "path", path: raw(id) }, format: "jpeg", size, mode: "bestfit" }) } });
  if (res.ok && res.body) return res;
  await res.body?.cancel().catch(() => {});
  return null;
}

// ---- The folder browser -----------------------------------------------------------------------------------------------------
export interface BoxEntry { id: string; name: string; folder: boolean; canWrite: boolean; modified?: string; size?: number; kind?: "image" | "video" | "trip" | "file"; owner?: string }
const kindOf = (n: string): BoxEntry["kind"] => (/\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(n) ? "image" : /\.(mp4|mov|m4v|webm)$/i.test(n) ? "video" : /\.json$/i.test(n) ? "trip" : "file");

/** What's in a place: the top of the Dropbox ("root"), the folders shared with you ("shared", added to the Dropbox or
 *  not), or a folder (its id). Folders first. */
export async function browse(where: string): Promise<{ entries: BoxEntry[]; more: boolean }> {
  if (where === "shared") {
    const r = await rpc("/2/sharing/list_folders", { limit: 200 });
    const entries: BoxEntry[] = (r.entries || []).map((f: any) => ({
      // One that isn't in the Dropbox yet has no path: choosing or opening it adds it (sharing/mount_folder).
      id: f.path_lower ? `${PREFIX}ns:${f.shared_folder_id}` : `${PREFIX}mount:${f.shared_folder_id}`,
      name: String(f.name || ""), folder: true, canWrite: f.access_type?.[".tag"] !== "viewer",
      ...(f.path_lower ? {} : { owner: "not in your Dropbox yet" }),
    }));
    return { entries, more: !!r.cursor };
  }
  const p = where === "root" ? "" : await folderPath(where);
  const all = await listAll(p);
  const entries: BoxEntry[] = all.filter((m) => m[".tag"] !== "deleted").map((m) => ({
    id: PREFIX + m.id, name: m.name, folder: m[".tag"] === "folder", canWrite: !m.sharing_info?.read_only,
    ...(m.server_modified ? { modified: m.server_modified } : {}), ...(m.size != null ? { size: m.size } : {}), ...(m[".tag"] === "file" ? { kind: kindOf(m.name) } : {}),
  }));
  entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { entries: entries.slice(0, 600), more: entries.length > 600 };
}

/** A browser id as a Dropbox path to list: a folder id, a shared folder in the Dropbox (its namespace), or one to add. */
async function folderPath(where: string): Promise<string> {
  const r = where.startsWith(PREFIX) ? raw(where) : where;
  if (r.startsWith("ns:")) {
    const f = await rpc("/2/sharing/get_folder_metadata", { shared_folder_id: r.slice(3) });
    if (!f.path_lower) throw new Error("That shared folder isn't in your Dropbox.");
    return f.path_lower;
  }
  if (r.startsWith("mount:")) return (await mount(r.slice(6))).path;
  if (/^id:[\w-]{6,}$/.test(r)) return r;
  throw new Error("No such Dropbox folder.");
}

/** Adds a folder someone shared with you to your Dropbox (what "Add to Dropbox" does on the website). */
async function mount(sharedFolderId: string): Promise<{ id: string; name: string; path: string }> {
  const f = await rpc("/2/sharing/mount_folder", { shared_folder_id: sharedFolderId });
  const m: Meta = await rpc("/2/files/get_metadata", { path: f.path_lower });
  return { id: PREFIX + m.id, name: m.name, path: f.path_lower };
}

/** A browser choice as the folder to sync with: a shared folder becomes its folder id (added to the Dropbox if needed). */
export async function resolveFolder(id: string): Promise<string> {
  const r = id.startsWith(PREFIX) ? raw(id) : id;
  if (r.startsWith("mount:")) return (await mount(r.slice(6))).id;
  if (r.startsWith("ns:")) { const m: Meta = await rpc("/2/files/get_metadata", { path: await folderPath(id) }); return PREFIX + m.id; }
  return PREFIX + r;
}

/** A Dropbox folder from its shared link (dropbox.com/scl/fo/…): it has to be in the person's Dropbox. */
export async function folderFromLink(url: string): Promise<string> {
  const m: Meta & { path_lower?: string } = await rpc("/2/sharing/get_shared_link_metadata", { url });
  if (m[".tag"] !== "folder") throw new Error("That Dropbox link is to a file, not a folder.");
  if (!m.path_lower) throw new Error("That folder isn't in your Dropbox yet: open the link in your browser, press “Add to Dropbox”, then add it here.");
  return PREFIX + m.id;
}

export async function createFolder(name: string, parent = "root"): Promise<{ id: string; name: string; canWrite: boolean }> {
  const clean = String(name || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 100);
  if (!clean) throw new Error("Give the folder a name.");
  const base = parent === "root" ? "" : await folderPath(parent);
  const r = await rpc("/2/files/create_folder_v2", { path: `${base}/${clean}`, autorename: false });
  return { id: PREFIX + r.metadata.id, name: r.metadata.name, canWrite: true };
}
