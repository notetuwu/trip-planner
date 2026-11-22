// Is there a newer release on GitHub? Only the packaged app asks, and sparingly: GitHub limits requests per home
// connection (shared with every phone and computer on it, so a chatty app gets the whole household blocked from
// github.com). The answer is kept for an hour (Settings → Updates → Check now asks straight away, at most once a
// minute), "nothing changed" answers carry the last ETag (GitHub doesn't count those), and after a refusal it waits
// until GitHub says it may ask again. It never falls back to loading github.com pages when the API refused.
// TRIP_PLANNER_NO_UPDATES=1 or Settings → Updates turns the automatic check off. Also works out how this copy can update itself.
import fs from "node:fs";
import path from "node:path";
import { PACKAGED, USER_AGENT, VERSION } from "../config";
import { readSettings } from "../settings";

export const REPO = "notetuwu/trip-planner";

/** installer: Windows, installed with the setup; portable: Windows zip; manual: download it yourself (macOS, Linux). */
export type UpdateMode = "installer" | "portable" | "manual";

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
}

const newerThan = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export function updateMode(): UpdateMode {
  if (process.platform !== "win32") return "manual";
  const dir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(dir, "unins000.exe"))) return "installer"; // Inno Setup's uninstaller sits next to it
  if (fs.existsSync(path.join(dir, "data"))) return "portable";
  return "manual";
}

interface Release { tag: string; url: string; assets: { name: string; url: string; size: number; sha256?: string }[] }

/** GitHub refused (rate limit): don't ask again before `until`, and don't try github.com pages either. */
class Refused extends Error { constructor(msg: string, readonly until: number) { super(msg); } }

// Hourly: "nothing new" answers to the ETag aren't counted by GitHub, so that's at most 24 counted requests a day.
const AUTO_EVERY = 3600e3, MANUAL_GAP = 60e3, FAIL_WAIT = 30 * 60e3;
let etag = "", lastRelease: Release | null = null;

/** The latest release from GitHub's API (with file sizes and checksums). */
async function fromApi(): Promise<Release> {
  // TRIP_PLANNER_UPDATE_URL: a different place to ask (for testing the updater against a local fake release).
  const res = await fetch(process.env.TRIP_PLANNER_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json", ...(etag && lastRelease ? { "If-None-Match": etag } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 304 && lastRelease) return lastRelease;
  if (res.status === 403 || res.status === 429) {
    // Primary limit: x-ratelimit-reset (seconds since 1970); secondary: retry-after (seconds); otherwise an hour.
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000, after = Number(res.headers.get("retry-after")) * 1000;
    const until = after > 0 ? Date.now() + after : reset > Date.now() ? reset : Date.now() + 3600e3;
    throw new Refused(`GitHub asked to wait (too many requests from this connection)`, until);
  }
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel: any = await res.json();
  etag = res.headers.get("etag") || "";
  return lastRelease = {
    tag: String(rel.tag_name || ""), url: rel.html_url,
    assets: (rel.assets || []).map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || "").replace(/^sha256:/, "") || undefined })),
  };
}

/** When the API can't be reached at all (not when it refused): the releases page redirects to the latest tag, and
 *  the files have fixed names. No checksums this way; the download still comes over HTTPS from GitHub. */
async function fromReleasesPage(): Promise<Release> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  const tag = (res.headers.get("location") || "").match(/\/tag\/([^/?#]+)/)?.[1];
  if (!tag) throw new Error(`GitHub releases page: HTTP ${res.status}`);
  const v = tag.replace(/^v/, ""), file = (suffix: string) => `Trip-Planner-${v}${suffix}`;
  const assets = ["-windows-x64-setup.exe", "-windows-x64-portable.zip"].map((suffix) => ({
    name: file(suffix), url: `https://github.com/${REPO}/releases/download/${tag}/${file(suffix)}`, size: 0,
  }));
  return { tag, url: `https://github.com/${REPO}/releases/tag/${tag}`, assets };
}

let cached: UpdateInfo | null = null, error = "", waitUntil = 0, lastAsked = 0;
let inFlight: Promise<UpdateInfo | null> | null = null;

const available = () => PACKAGED && !process.env.TRIP_PLANNER_NO_UPDATES && VERSION !== "dev";

export const updateState = (): UpdateState => ({ info: cached, error, waitUntil, auto: readSettings().checkUpdates, available: available() });

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
    if (process.env.TRIP_PLANNER_UPDATE_URL) waitUntil = 0;
    throw e;
  }
  error = ""; waitUntil = 0;
  const latest = rel.tag.replace(/^v/, "");
  const mode = updateMode();
  const suffix = mode === "installer" ? "-windows-x64-setup.exe" : mode === "portable" ? "-windows-x64-portable.zip" : null;
  const asset = suffix ? rel.assets.find((x) => x.name.endsWith(suffix)) : undefined;
  cached = {
    current: VERSION, latest, newer: !!latest && newerThan(latest, VERSION), notesUrl: rel.url, mode: asset || !suffix ? mode : "manual",
    ...(asset ? { asset } : {}), checkedAt: Date.now(),
  };
  return cached;
}
