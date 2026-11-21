// Is there a newer release on GitHub? Only the packaged app asks (once per start, cached for a few hours);
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

let cached: { at: number; info: UpdateInfo | null } | null = null;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!PACKAGED || process.env.TRIP_PLANNER_NO_UPDATES || VERSION === "dev") return null;
  if (cached && Date.now() - cached.at < 6 * 3600e3) return cached.info;
  // TRIP_PLANNER_UPDATE_URL: a different place to ask (for testing the updater against a local fake release).
  const res = await fetch(process.env.TRIP_PLANNER_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const rel: any = await res.json();
  const latest = String(rel.tag_name || "").replace(/^v/, "");
  const mode = updateMode();
  const suffix = mode === "installer" ? "-windows-x64-setup.exe" : mode === "portable" ? "-windows-x64-portable.zip" : null;
  const a = suffix ? (rel.assets || []).find((x: any) => String(x.name).endsWith(suffix)) : null;
  const info: UpdateInfo = {
    current: VERSION, latest, newer: !!latest && newerThan(latest, VERSION), notesUrl: rel.html_url, mode: a || !suffix ? mode : "manual",
    ...(a ? { asset: { name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest || "").replace(/^sha256:/, "") || undefined } } : {}),
  };
  cached = { at: Date.now(), info };
  return info;
}
