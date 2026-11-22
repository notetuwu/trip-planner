// Paths, limits and small helpers used across the server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSea } from "node:sea";

/** The app's version, filled in at build time from package.json. */
declare const __APP_VERSION__: string | undefined;
export const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** Running as the packaged app (one executable file) rather than from the source folder. */
export const PACKAGED = isSea();

/** The packaged app keeps its data in a "data" folder next to it (portable) or else in the user's app-data folder. */
function packagedDataDir() {
  const portable = path.join(path.dirname(process.execPath), "data");
  if (fs.existsSync(portable)) return portable;
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Trip Planner");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Trip Planner");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "trip-planner");
}

/** Where saves/, lists/, cache/ and any CSVs live: TRIP_PLANNER_DATA, else the app's data folder when packaged,
 *  else the project folder. */
export const ROOT = path.resolve(process.env.TRIP_PLANNER_DATA || (PACKAGED ? packagedDataDir() : process.cwd()));
/** The packaged app uses an uncommon port, so it doesn't collide with dev servers (and keeps its storage). */
export const PORT = Number(process.env.PORT) || (PACKAGED ? 47615 : 5173);
export const SAVES_DIR = path.join(ROOT, "saves");
export const LISTS_DIR = path.join(ROOT, "lists");
export const CACHE_DIR = path.join(ROOT, "cache");

/** Research runs can take a while. */
export const TIMEOUT_MS = 25 * 60 * 1000;

/** Sent to the free OpenStreetMap services, which ask for an identifiable client. */
export const USER_AGENT = "local-trip-planner/3 (+https://github.com/notetuwu/trip-planner)";
/** For sites that only answer browsers (Google lists, DuckDuckGo, web pages read during research). */
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Names become file names, so keep them to letters, digits, spaces, - and _. */
export const cleanName = (name: unknown) => String(name || "").trim().replace(/[^\p{L}\p{N}_\- ]+/gu, "").trim().slice(0, 80);

export const addDays = (iso: string, n: number) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

/** Error message of anything thrown. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
