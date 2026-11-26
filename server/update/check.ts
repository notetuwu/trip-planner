// Is there a newer release on GitHub? Only the packaged app asks, and sparingly: GitHub limits requests per home
// connection (shared with every phone and computer on it, so a chatty app gets the whole household blocked from
// github.com). The answer is kept for an hour (Settings → Updates → Check now asks straight away, at most once a
// minute), "nothing changed" answers carry the last ETag (GitHub doesn't count those), and after a refusal it waits
// until GitHub says it may ask again. It never falls back to loading github.com pages when the API refused.
// TRIP_PLANNER_NO_UPDATES=1 or Settings → Updates turns the automatic check off. Also works out how this copy can update itself.
import fs from "node:fs";
import path from "node:path";
import { canRollBack } from "../../shared/version";
import { PACKAGED, USER_AGENT, VERSION } from "../config";
import { readSettings } from "../settings";

export const REPO = "notetuwu/trip-planner";

/** installer: Windows, installed with the setup; portable: Windows zip; mac: the .app swapped for the new one; linux: the
 *  program swapped for the new one; manual: download it yourself (it can't change where it's installed). */
export type UpdateMode = "installer" | "portable" | "mac" | "linux" | "manual";

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  notesUrl: string;
  mode: UpdateMode;
  asset?: { name: string; url: string; size: number; sha256?: string };
  /** When GitHub was last asked successfully (ms). */
  checkedAt: number;
}

/** What Settings → Updates shows. */
export interface UpdateState {
  info: UpdateInfo | null;
  /** Why the last check failed ("" when it didn't). */
  error: string;
  /** Not before then (ms): GitHub asked to wait, or the last check failed. */
  waitUntil: number;
  /** The automatic check is on (Settings → Updates). */
  auto: boolean;
  /** Only the packaged app checks. */
  available: boolean;
  /** How this copy can install a version (also an older one: Settings → Updates → Roll back). */
  mode: UpdateMode;
}

const newerThan = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** The .app the running macOS app is ("…/Trip Planner.app"), or null. */
export function macBundle(exe = process.execPath) {
  const m = exe.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

const writable = (dir: string) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

export function updateMode(): UpdateMode {
  if (process.platform === "darwin") {
    // Started from where it was downloaded without moving it, macOS runs a read-only copy (App Translocation).
    const app = macBundle();
    return app && !app.includes("/AppTranslocation/") && writable(path.dirname(app)) && writable(app) ? "mac" : "manual";
  }
  if (process.platform === "linux") return writable(path.dirname(process.execPath)) ? "linux" : "manual";
  if (process.platform !== "win32") return "manual";
  const dir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(dir, "unins000.exe"))) return "installer"; // Inno Setup's uninstaller sits next to it
  if (fs.existsSync(path.join(dir, "data"))) return "portable";
  return "manual";
}

interface Release { tag: string; url: string; assets: { name: string; url: string; size: number; sha256?: string }[] }

const headers = () => ({ "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" });

/** A release as GitHub's API describes it. */
const toRelease = (rel: any): Release => ({
  tag: String(rel.tag_name || ""), url: rel.html_url,
  assets: (rel.assets || []).map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || "").replace(/^sha256:/, "") || undefined })),
});

/** Throws when GitHub's answer is "too many requests": when it may be asked again is in the error. */
function checkRefused(res: Response) {
  if (res.status !== 403 && res.status !== 429) return;
  // Primary limit: x-ratelimit-reset (seconds since 1970); secondary: retry-after (seconds); otherwise an hour.
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000, after = Number(res.headers.get("retry-after")) * 1000;
  const until = after > 0 ? Date.now() + after : reset > Date.now() ? reset : Date.now() + 3600e3;
  throw new Refused(`GitHub asked to wait (too many requests from this connection)`, until);
}

/** The file of a release that this copy installs (none: it's downloaded by hand). */
function assetFor(rel: Release, mode: UpdateMode) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const suffix = mode === "installer" ? "-windows-x64-setup.exe" : mode === "portable" ? "-windows-x64-portable.zip"
    : mode === "mac" ? `-macos-${arch}.zip` : mode === "linux" ? `-linux-${arch}.tar.gz` : null;
  return suffix ? rel.assets.find((x) => x.name.endsWith(suffix)) : undefined;
}

/** GitHub refused (rate limit): don't ask again before `until`, and don't try github.com pages either. */
class Refused extends Error { constructor(msg: string, readonly until: number) { super(msg); } }

// Hourly: "nothing new" answers to the ETag aren't counted by GitHub, so that's at most 24 counted requests a day.
const AUTO_EVERY = 3600e3, MANUAL_GAP = 60e3, FAIL_WAIT = 30 * 60e3;
let etag = "", lastRelease: Release | null = null;

/** The latest release from GitHub's API (with file sizes and checksums). */
async function fromApi(): Promise<Release> {
  // TRIP_PLANNER_UPDATE_URL: a different place to ask (for testing the updater against a local fake release).
  const res = await fetch(process.env.TRIP_PLANNER_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { ...headers(), ...(etag && lastRelease ? { "If-None-Match": etag } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 304 && lastRelease) return lastRelease;
  checkRefused(res);
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel: any = await res.json();
  etag = res.headers.get("etag") || "";
  return lastRelease = toRelease(rel);
}

/** When the API can't be reached at all (not when it refused): the releases page redirects to the latest tag, and
 *  the files have fixed names. No checksums this way; the download still comes over HTTPS from GitHub. */
async function fromReleasesPage(): Promise<Release> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  const tag = (res.headers.get("location") || "").match(/\/tag\/([^/?#]+)/)?.[1];
  if (!tag) throw new Error(`GitHub releases page: HTTP ${res.status}`);
  const v = tag.replace(/^v/, ""), file = (suffix: string) => `Trip-Planner-${v}${suffix}`;
  const assets = ["-windows-x64-setup.exe", "-windows-x64-portable.zip", "-macos-arm64.zip", "-macos-x64.zip", "-linux-x64.tar.gz"].map((suffix) => ({
    name: file(suffix), url: `https://github.com/${REPO}/releases/download/${tag}/${file(suffix)}`, size: 0,
  }));
  return { tag, url: `https://github.com/${REPO}/releases/tag/${tag}`, assets };
}

let cached: UpdateInfo | null = null, error = "", waitUntil = 0, refusedUntil = 0, lastAsked = 0;
let inFlight: Promise<UpdateInfo | null> | null = null;

const available = () => PACKAGED && !process.env.TRIP_PLANNER_NO_UPDATES && VERSION !== "dev";

export const updateState = (): UpdateState => ({ info: cached, error, waitUntil, auto: readSettings().checkUpdates, available: available(), mode: updateMode() });

/** The latest release. `force` (Check now) asks GitHub unless it did in the last minute or asked to wait; otherwise
 *  the answer from the last hour is used, and nothing is asked at all when the automatic check is off. */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  if (!available()) return null;
  const now = Date.now();
  if (now < waitUntil) return cached;
  if (force ? now - lastAsked < MANUAL_GAP : cached && now - cached.checkedAt < AUTO_EVERY) return cached;
  if (!force && !readSettings().checkUpdates) return cached;
  // Several windows asking at once share one request.
  return (inFlight ??= ask().finally(() => { inFlight = null; }));
}

async function ask(): Promise<UpdateInfo | null> {
  lastAsked = Date.now();
  let rel: Release;
  try {
    try { rel = await fromApi(); }
    catch (e) {
      if (e instanceof Refused || process.env.TRIP_PLANNER_UPDATE_URL) throw e;
      rel = await fromReleasesPage();
    }
  } catch (e) {
    error = (e as Error).message;
    waitUntil = e instanceof Refused ? e.until : Date.now() + FAIL_WAIT;
    if (e instanceof Refused) refusedUntil = e.until;
    if (process.env.TRIP_PLANNER_UPDATE_URL) waitUntil = 0;
    throw e;
  }
  error = ""; waitUntil = 0;
  const latest = rel.tag.replace(/^v/, "");
  const mode = updateMode();
  const asset = assetFor(rel, mode);
  cached = {
    current: VERSION, latest, newer: !!latest && newerThan(latest, VERSION), notesUrl: rel.url, mode: asset ? mode : "manual",
    ...(asset ? { asset } : {}), checkedAt: Date.now(),
  };
  return cached;
}

/** An older version's release, to roll back to it (asked only when someone presses Roll back). It waits like the update
 *  check when GitHub has refused. */
export async function findOlderRelease(version: string): Promise<UpdateInfo> {
  if (!available()) throw new Error("Only the installed app can change its version.");
  if (!/^\d+\.\d+\.\d+$/.test(version) || !canRollBack(version, VERSION)) throw new Error(`Can't roll back to ${version}.`);
  if (Date.now() < refusedUntil) throw new Error("GitHub asked to wait (too many requests from this connection). Try again later.");
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, { headers: headers(), signal: AbortSignal.timeout(10000) });
  try { checkRefused(res); }
  catch (e) { refusedUntil = waitUntil = (e as Refused).until; error = (e as Error).message; throw e; }
  if (res.status === 404) throw new Error(`There's no download of ${version} on GitHub.`);
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel = toRelease(await res.json()), mode = updateMode(), asset = assetFor(rel, mode);
  if (!asset) throw new Error(`${version} has no download this copy can install by itself.`);
  return { current: VERSION, latest: version, newer: false, notesUrl: rel.url, mode, asset, checkedAt: Date.now() };
}
