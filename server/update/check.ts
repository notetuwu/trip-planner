// Is there a newer release on GitHub? Only the packaged app asks (the answer is kept for 5 minutes: at most 12 requests an hour, well under GitHub's 60 per connection);
// TRIP_PLANNER_NO_UPDATES=1 turns it off. Also works out how this copy can update itself.
import fs from "node:fs";
import path from "node:path";
import { PACKAGED, USER_AGENT, VERSION } from "../config";

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

let cached: { at: number; info: UpdateInfo } | null = null;

interface Release { tag: string; url: string; assets: { name: string; url: string; size: number; sha256?: string }[] }

/** The latest release from GitHub's API (with file sizes and checksums). */
async function fromApi(): Promise<Release> {
  // TRIP_PLANNER_UPDATE_URL: a different place to ask (for testing the updater against a local fake release).
  const res = await fetch(process.env.TRIP_PLANNER_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API: HTTP ${res.status}`);
  const rel: any = await res.json();
  return {
    tag: String(rel.tag_name || ""), url: rel.html_url,
    assets: (rel.assets || []).map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || "").replace(/^sha256:/, "") || undefined })),
  };
}

/** Without the API (it allows 60 requests an hour per connection): the releases page redirects to the latest tag, and
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

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!PACKAGED || process.env.TRIP_PLANNER_NO_UPDATES || VERSION === "dev") return null;
  // "Nothing new" is kept for an hour; failures aren't kept at all.
  if (cached && Date.now() - cached.at < 5 * 60e3) return cached.info;
  let rel: Release;
  try { rel = await fromApi(); }
  catch (e) {
    if (process.env.TRIP_PLANNER_UPDATE_URL) throw e;
    rel = await fromReleasesPage();
  }
  const latest = rel.tag.replace(/^v/, "");
  const mode = updateMode();
  const suffix = mode === "installer" ? "-windows-x64-setup.exe" : mode === "portable" ? "-windows-x64-portable.zip" : null;
  const asset = suffix ? rel.assets.find((x) => x.name.endsWith(suffix)) : undefined;
  const info: UpdateInfo = {
    current: VERSION, latest, newer: !!latest && newerThan(latest, VERSION), notesUrl: rel.url, mode: asset || !suffix ? mode : "manual",
    ...(asset ? { asset } : {}),
  };
  cached = { at: Date.now(), info };
  return info;
}
