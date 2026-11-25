// Google sign-in and Google Drive, for syncing trips (Settings → Sync).
//
// Sign-in is Google's flow for desktop apps: the default browser opens Google's page, and Google sends the browser back to
// a small one-off server on this computer (127.0.0.1, a free port) with a code, which is swapped for a token. PKCE and a
// random `state` make sure only the sign-in started here is accepted.
//
// Safety:
//  - The token is kept in the data folder (sync/google-auth.json, readable only by this user where the system allows) and
//    is never sent to the page, to a phone, into a trip or into a sync folder.
//  - The app ships with no sign-in ID: each person brings their own (a free OAuth client from the Google Cloud Console),
//    entered in Settings → Sync and kept in sync/google-client.json, or given as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//    (see docs/google-sync.md). So nobody shares anybody else's user limit.
//  - Drive is only touched in the folders added in Settings → Sync, and nothing is ever deleted there (see sync.ts).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT, USER_AGENT, errMsg } from "../config";
import { openInBrowser } from "../launcher";

export const SYNC_DIR = path.join(ROOT, "sync");
const AUTH_FILE = path.join(SYNC_DIR, "google-auth.json");
const CLIENT_FILE = path.join(SYNC_DIR, "google-client.json");
/** Every file in Drive: needed to see trips other people put in a shared folder (a narrower permission only covers
 *  files this app made with the same account). Only the sync folders are ever used. */
export const SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_TYPE = "application/vnd.google-apps.folder";

export interface Client { id: string; secret: string }

function savedClient(): Client | null {
  try {
    const c = JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8"));
    return typeof c?.id === "string" && typeof c?.secret === "string" && c.id && c.secret ? { id: c.id, secret: c.secret } : null;
  } catch { return null; }
}
function envClient(): Client | null {
  const id = (process.env.GOOGLE_CLIENT_ID || "").trim(), secret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return id && secret ? { id, secret } : null;
}

/** The person's own Google sign-in ID and secret: from Settings → Sync, else the environment. */
export const client = (): Client | null => savedClient() || envClient();
/** Where it comes from, and the ID (not secret: it shows on Google's sign-in page). The secret never leaves the server. */
export function clientInfo(): { clientFrom: "app" | "env" | ""; clientId: string } {
  const saved = savedClient(), c = saved || envClient();
  return { clientFrom: saved ? "app" : c ? "env" : "", clientId: c?.id || "" };
}

/** What was pasted: the ID and the secret, or the whole JSON file Google offers to download (in the first field). */
export function parseClient(idText: string, secretText: string): Client {
  let id = String(idText || "").trim(), secret = String(secretText || "").trim();
  if (id.startsWith("{")) {
    let json: any;
    try { json = JSON.parse(id); } catch { throw new Error("That file's text is incomplete. Paste all of it, or the client ID and secret on their own."); }
    if (json?.web) throw new Error('That\'s a "Web application" client. Create one of the type "Desktop app".');
    id = String(json?.installed?.client_id || "").trim();
    secret = String(json?.installed?.client_secret || "").trim();
  }
  if (/^AIza/.test(id) || /^AIza/.test(secret)) throw new Error("That's an API key. Sign-in needs an OAuth client ID and secret (step 5 of the guide).");
  if (!/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/.test(id)) throw new Error('The client ID ends in ".apps.googleusercontent.com". Check what you pasted.');
  if (!/^[\w-]{10,200}$/.test(secret)) throw new Error("Paste the client secret too (it usually starts with GOCSPX-).");
  return { id, secret };
}

/** Saves the ID and secret entered in Settings (null removes them). A sign-in made with another ID ends. */
export async function setClient(next: Client | null) {
  const before = client();
  if (next) {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    fs.writeFileSync(CLIENT_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  } else { try { fs.unlinkSync(CLIENT_FILE); } catch { /* none */ } }
  if (before?.id !== client()?.id) await signOut();
}

interface Auth { refresh: string; email: string; name: string; at: number; expired?: boolean }

export function readAuth(): Auth | null {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return a && typeof a.refresh === "string" && a.refresh ? a : null;
  } catch { return null; }
}
function writeAuth(a: Auth | null) {
  if (!a) { try { fs.unlinkSync(AUTH_FILE); } catch { /* none */ } return; }
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

let access: { token: string; until: number } | null = null;

// ---- Signing in ----------------------------------------------------------------------------------------------------------
const b64url = (b: Buffer) => b.toString("base64url");
let pending: { server: http.Server; timer: NodeJS.Timeout } | null = null;
let signInError = "";
export const signInState = () => ({ signingIn: !!pending, signInError });

function stopPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending.server.closeAllConnections?.();
  pending = null;
}

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:40px;max-width:520px;margin:auto;color:#222"><h2>${title}</h2><p>${text}</p></body>`;
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Starts signing in: opens Google's page in the default browser. Returns the page's address (shown as a link too, in
 *  case the browser doesn't open). */
export async function startSignIn(): Promise<string> {
  const c = client();
  if (!c) throw new Error("Add your Google client ID and secret first (Settings → Sync).");
  stopPending();
  signInError = "";
  const state = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as { port: number }).port, redirect = `http://127.0.0.1:${port}/`;

  server.on("request", async (req, res) => {
    const url = new URL(req.url || "/", redirect);
    if (url.pathname !== "/" || req.method !== "GET") { res.writeHead(404).end(); return; }
    const answer = (status: number, title: string, text: string) => { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); res.end(page(title, text)); };
    // Only the answer to the sign-in started here counts.
    if (url.searchParams.get("state") !== state) return answer(400, "That didn't work", "This sign-in page is out of date. Start again from Trip Planner (Settings → Sync).");
    const done = (error = "") => { signInError = error; stopPending(); };
    const err = url.searchParams.get("error");
    if (err) {
      answer(200, "Not signed in", "Google didn't sign you in, so nothing changed. You can close this tab.");
      return done(err === "access_denied" ? "Signing in was cancelled." : `Google said: ${err}`);
    }
    try {
      await finishSignIn(c, String(url.searchParams.get("code") || ""), verifier, redirect);
      answer(200, "Signed in", "Trip Planner can sync your trips now. You can close this tab and go back to the app.");
      done();
    } catch (e) {
      answer(200, "That didn't work", escHtml(errMsg(e)));
      done(errMsg(e));
    }
  });
  // Nobody finished within 10 minutes: stop waiting.
  pending = { server, timer: setTimeout(() => { if (pending?.server === server) { signInError = "Signing in took too long. Try again."; stopPending(); } }, 10 * 60_000) };

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: c.id, redirect_uri: redirect, response_type: "code", scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: "S256",
    // A refresh token, so it stays signed in.
    access_type: "offline", prompt: "consent",
  })}`;
  openInBrowser(url);
  return url;
}

async function token(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(30000),
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

async function finishSignIn(c: { id: string; secret: string }, code: string, verifier: string, redirect: string) {
  if (!code) throw new Error("Google sent no sign-in code.");
  const { ok, json } = await token({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
  if (!ok || !json.access_token) throw new Error(`Google refused the sign-in: ${json.error_description || json.error || "no token"}`);
  // Google lets people untick permissions on its page: without Drive there's nothing to sync with.
  if (!String(json.scope || "").split(" ").includes(SCOPE)) {
    await revoke(json.refresh_token || json.access_token);
    throw new Error("Drive access wasn't allowed (it was unticked on Google's page). Sign in again and leave the Drive box ticked.");
  }
  if (!json.refresh_token) throw new Error("Google didn't let the app stay signed in. Sign in again.");
  access = { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  const about: any = await driveJson(`${DRIVE}/about?fields=user(displayName,emailAddress)`);
  writeAuth({ refresh: json.refresh_token, email: String(about?.user?.emailAddress || ""), name: String(about?.user?.displayName || ""), at: Date.now() });
}

async function revoke(t: string) {
  if (!t) return;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: "POST", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }).catch(() => {});
}

/** Signs out: Google is told to forget the app's access, and the token is deleted here. */
export async function signOut() {
  stopPending();
  const a = readAuth();
  access = null;
  writeAuth(null);
  if (a) await revoke(a.refresh);
}

export class SignedOut extends Error {}

async function accessToken(): Promise<string> {
  if (access && access.until > Date.now() + 60_000) return access.token;
  const a = readAuth(), c = client();
  if (!a || a.expired) throw new SignedOut("Not signed in to Google.");
  if (!c) throw new SignedOut("Add your Google client ID and secret in Settings → Sync.");
  const { ok, json } = await token({ refresh_token: a.refresh, client_id: c.id, client_secret: c.secret, grant_type: "refresh_token" });
  if (!ok) {
    // The access was removed (in the Google account, or it expired): sign in again. The token is useless, so it goes.
    if (json.error === "invalid_grant") { writeAuth({ ...a, refresh: "-", expired: true }); throw new SignedOut("Google signed this computer out. Sign in again in Settings → Sync."); }
    throw new Error(`Google: ${json.error_description || json.error || "couldn't sign in"}`);
  }
  access = { token: json.access_token, until: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return access.token;
}

/** Who is signed in ("" when nobody). */
export function account() {
  const a = readAuth();
  return { signedIn: !!a && !a.expired, expired: !!a?.expired, email: a?.email || "", name: a?.name || "" };
}

// ---- Drive ---------------------------------------------------------------------------------------------------------------
/** What Google said, in words that say what to do. */
function explain(status: number, body: any): string {
  const e = body?.error, reason = e?.errors?.[0]?.reason || "", msg = String(e?.message || "");
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason + msg) || /has not been used|is disabled/i.test(msg))
    return "The Drive API isn't switched on for your Google project (step 2 of the guide in Settings → Sync).";
  if (status === 403 && /rateLimit|quota/i.test(reason + msg)) return "Google's limit is used up for now. It tries again later.";
  if (status === 404) return "Google can't find it (deleted, or not shared with this account).";
  if (status === 403) return "This account isn't allowed to do that here (ask for edit access in Drive).";
  return `Google answered ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
}

async function drive(url: string, init: RequestInit = {}, again = true): Promise<Response> {
  const t = await accessToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}`, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (res.status === 401 && again) { access = null; return drive(url, init, false); }
  return res;
}
async function driveJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await drive(url, init);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, json));
  return json;
}

/** Drive ids are letters, digits, - and _ (checked before one goes into a query or an address). */
export const isDriveId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{10,200}$/.test(id);

export interface DriveFile {
  id: string;
  name: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  capabilities?: { canEdit?: boolean };
  properties?: Record<string, string>;
}
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,size,lastModifyingUser(displayName,emailAddress),capabilities(canEdit),properties";

/** A folder's name and whether this account may add files to it. */
export async function folderInfo(id: string): Promise<{ id: string; name: string; canWrite: boolean }> {
  if (!isDriveId(id)) throw new Error("That doesn't look like a Google Drive folder link.");
  const f = await driveJson(`${DRIVE}/files/${id}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
  if (f.mimeType !== FOLDER_TYPE) throw new Error("That link is a file, not a folder. Open the folder in Drive and copy its link.");
  if (f.trashed) throw new Error("That folder is in the Drive trash.");
  return { id: f.id, name: String(f.name || ""), canWrite: !!f.capabilities?.canAddChildren };
}

/** A new folder at the top of My Drive. */
export async function createFolder(name: string) {
  const f = await driveJson(`${DRIVE}/files?fields=id,name&supportsAllDrives=true`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_TYPE }),
  });
  return { id: String(f.id), name: String(f.name || name), canWrite: true };
}

export const TRIP_SUFFIX = ".trip.json";

/** The files in a folder that can hold a trip: any .json (an export, or a saved trip's file put there by hand; what's
 *  inside decides). Only in the folder itself, not in folders inside it. */
export async function listTripFiles(folder: string): Promise<DriveFile[]> {
  if (!isDriveId(folder)) throw new Error("Not a folder id");
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false and mimeType != '${FOLDER_TYPE}'`,
      fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const json = await driveJson(`${DRIVE}/files?${q}`);
    for (const f of json.files || []) if (String(f.name || "").toLowerCase().endsWith(".json") && !(Number(f.size) > MAX_TRIP_BYTES)) out.push(f);
    pageToken = json.nextPageToken || "";
  } while (pageToken && out.length < 2000);
  return out;
}

export async function fileMeta(id: string): Promise<DriveFile & { trashed?: boolean }> {
  if (!isDriveId(id)) throw new Error("Not a file id");
  return driveJson(`${DRIVE}/files/${id}?fields=${FILE_FIELDS},trashed&supportsAllDrives=true`);
}

const MAX_TRIP_BYTES = 25 * 1024 * 1024;

export async function download(id: string): Promise<string> {
  if (!isDriveId(id)) throw new Error("Not a file id");
  const res = await drive(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`);
  if (!res.ok) throw new Error(explain(res.status, await res.json().catch(() => ({}))));
  if (Number(res.headers.get("content-length")) > MAX_TRIP_BYTES) throw new Error("That trip file is too big.");
  const text = await res.text();
  if (text.length > MAX_TRIP_BYTES) throw new Error("That trip file is too big.");
  return text;
}

/** Writes a trip file: a new one in `folder`, or a new version of file `id` (Drive keeps the earlier versions). */
export async function upload(o: { id?: string; folder?: string; name: string; text: string; properties?: Record<string, string> }): Promise<DriveFile> {
  const meta: Record<string, unknown> = { name: o.name, mimeType: "application/json", ...(o.properties ? { properties: o.properties } : {}) };
  if (o.id) { if (!isDriveId(o.id)) throw new Error("Not a file id"); }
  else { if (!isDriveId(o.folder)) throw new Error("Not a folder id"); meta.parents = [o.folder]; }
  const boundary = `tp-${crypto.randomBytes(12).toString("hex")}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${o.text}\r\n--${boundary}--`;
  const url = `${UPLOAD}/files${o.id ? `/${o.id}` : ""}?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`;
  return driveJson(url, { method: o.id ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
}
