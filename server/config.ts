// Paths, limits and small helpers used across the server.
import path from "node:path";

/** Where saves/, lists/, cache/ and any CSVs live: the project folder unless TRIP_PLANNER_DATA says otherwise. */
export const ROOT = path.resolve(process.env.TRIP_PLANNER_DATA || process.cwd());
export const PORT = Number(process.env.PORT) || 5173;
export const SAVES_DIR = path.join(ROOT, "saves");
export const LISTS_DIR = path.join(ROOT, "lists");
export const CACHE_DIR = path.join(ROOT, "cache");

/** Research runs can take a while. */
export const TIMEOUT_MS = 25 * 60 * 1000;

/** Sent to the free OpenStreetMap services, which ask for an identifiable client. */
export const USER_AGENT = "local-trip-planner/3.0";
/** For sites that only answer browsers (Google lists, DuckDuckGo, web pages read during research). */
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Names become file names, so keep them to letters, digits, spaces, - and _. */
export const cleanName = (name: unknown) => String(name || "").trim().replace(/[^\p{L}\p{N}_\- ]+/gu, "").trim().slice(0, 80);

export const addDays = (iso: string, n: number) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

/** Error message of anything thrown. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
