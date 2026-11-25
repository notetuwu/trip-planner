// App settings kept in the data folder (settings.json): how the app opens, phone access on the home network, and the
// context size for local models.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";

export type WindowMode = "app" | "browser";
export interface Settings {
  window: WindowMode;
  /** Phone access: the planner also answers on the home network (started with the app when on). */
  lan: boolean;
  /** The secret in the phone link; a new one locks out phones that had the old link. */
  lanToken: string;
  /** Context size for local models (tokens); 0 = decide per trip. */
  numCtx: number;
  /** Look for a new version by itself (every hour); off: only Settings → Updates → Check now asks. */
  checkUpdates: boolean;
  /** Research for local models: a Brave Search API key, and a SearXNG server's address (see Settings → Planning). */
  braveKey: string;
  searxngUrl: string;
  /** A free Geoapify key: a third, fast service for place lookups (Settings → Planning). */
  geoapifyKey: string;
  /** A Google API key with the Drive API on: lists the photos of a shared Drive folder for the map (Settings → Planning). */
  googleKey: string;
  /** The quick-start guide was shown (it opens by itself only the first time the app starts). */
  quickstartSeen: boolean;
  /** Where the map's downloaded transport lines are kept ("" = in the app's cache folder; Settings → General → Map). */
  linesDir: string;
  tune: Tune;
  app: AppPrefs;
}

/** Settings → General: how the page shows things and what a new trip starts with. */
export interface AppPrefs {
  /** Distances in kilometres or miles; times as 24-hour or 12-hour; dates as the system does, day first or month first. */
  units: "km" | "mi";
  clock: "24" | "12";
  dates: "auto" | "dmy" | "mdy";
  /** The map's start: place names in the local language or English; saved places and routes shown. */
  mapNames: "local" | "english";
  showPlaces: boolean;
  showRoutes: boolean;
  /** Where place and directions links open. */
  mapsApp: "google" | "apple" | "bing";
  /** On start: the trip that was open, or a new one (the open one is kept in Saved trips first). */
  startWith: "last" | "new";
  /** Save each newly generated plan to Saved trips by itself. */
  autoSave: boolean;
  /** A saved trip that's open is kept up to date by itself, a few seconds after each change (Settings → General). */
  liveSave: boolean;
  /** Look the plan's places up on Wikimedia for the trip preview's pictures (off unless switched on). */
  placePictures: boolean;
  /** Download the transport lines (for the map's Layers) around the trip's stays in the background, and how far around
   *  each stay (km). */
  /** The map's transport lines from OpenStreetMap (the Layers panel's lines, and the areas downloaded for them): off
   *  unless switched on (downloading them from the public servers is slow). */
  transitLines: boolean;
  linesDownload: boolean;
  linesRadius: number;
  /** What a new trip starts with. */
  newTrip: { currency: string; travelers: number; dailyBudget: number; pace: string };
}

export const APP_DEFAULTS: AppPrefs = {
  units: "km", clock: "24", dates: "auto", mapNames: "local", showPlaces: true, showRoutes: true, mapsApp: "google", startWith: "last", autoSave: false, liveSave: true, placePictures: false,
  transitLines: false, linesDownload: true, linesRadius: 10,
  newTrip: { currency: "EUR", travelers: 1, dailyBudget: 100, pace: "balanced (3-5 stops per day)" },
};
const PACES = ["relaxed (2-3 main stops per day, late starts)", "balanced (3-5 stops per day)", "packed (as much as possible, early starts)"];

function cleanApp(a: Partial<AppPrefs> = {}, base: AppPrefs = APP_DEFAULTS): AppPrefs {
  const pick = <K extends keyof AppPrefs>(k: K, ok: (v: unknown) => boolean) => (a[k] !== undefined && ok(a[k]) ? a[k]! : base[k]);
  const t: Partial<AppPrefs["newTrip"]> = a.newTrip && typeof a.newTrip === "object" ? a.newTrip : {};
  return {
    units: pick("units", (v) => v === "km" || v === "mi"),
    clock: pick("clock", (v) => v === "24" || v === "12"),
    dates: pick("dates", (v) => ["auto", "dmy", "mdy"].includes(v as string)),
    mapNames: pick("mapNames", (v) => v === "local" || v === "english"),
    showPlaces: pick("showPlaces", (v) => typeof v === "boolean"),
    showRoutes: pick("showRoutes", (v) => typeof v === "boolean"),
    mapsApp: pick("mapsApp", (v) => v === "google" || v === "apple" || v === "bing"),
    startWith: pick("startWith", (v) => v === "last" || v === "new"),
    autoSave: pick("autoSave", (v) => typeof v === "boolean"),
    liveSave: pick("liveSave", (v) => typeof v === "boolean"),
    placePictures: pick("placePictures", (v) => typeof v === "boolean"),
    transitLines: pick("transitLines", (v) => typeof v === "boolean"),
    linesDownload: pick("linesDownload", (v) => typeof v === "boolean"),
    linesRadius: Number(pick("linesRadius", (v) => [5, 10, 20].includes(Number(v)))),
    newTrip: {
      currency: typeof t.currency === "string" && /^[A-Z]{3}$/.test(t.currency) ? t.currency : base.newTrip.currency,
      travelers: Number.isInteger(Number(t.travelers)) && Number(t.travelers) >= 1 && Number(t.travelers) <= 30 ? Number(t.travelers) : base.newTrip.travelers,
      dailyBudget: Number.isFinite(Number(t.dailyBudget)) && Number(t.dailyBudget) >= 0 && Number(t.dailyBudget) <= 100000 && t.dailyBudget !== undefined ? Math.round(Number(t.dailyBudget)) : base.newTrip.dailyBudget,
      pace: typeof t.pace === "string" && PACES.includes(t.pace) ? t.pace : base.newTrip.pace,
    },
  };
}

/** How plans are made (Settings → Planning). */
export interface Tune {
  /** The language the plan is written in ("" = English). */
  language: string;
  /** How much the descriptions say. */
  detail: "brief" | "normal" | "detailed";
  /** How many real places around each stay go into the prompt. */
  places: "fewer" | "normal" | "more";
  /** Most web lookups while researching. */
  lookups: number;
  /** Rounds of fixing what the map and opening-hours checks find, before the plan is shown (when that's on). */
  fixRounds: number;
  /** Local models: think before answering (where they can), or answer straight away (faster). */
  thinking: "on" | "off";
  /** Local models: how varied the answers are (0 = always the most likely, 1 = more creative). */
  temperature: number;
  /** Local models: how long Ollama keeps the model loaded after a plan ("5m", "30m", "2h", "-1" = until Ollama stops). */
  keepAlive: string;
  /** Research: which pages may be opened: only ones found (searches, links on pages read), those plus a few the model
   *  knows itself, or any public page. */
  pages: "found" | "known" | "any";
  /** Research: the search engine (automatic: Brave or SearXNG when set up, else DuckDuckGo, then Wikipedia). */
  search: "auto" | "brave" | "searxng";
  /** Local models: plan in one go (one big prompt) or step by step (outline, research, then each day on its own). */
  localPlan: "whole" | "steps";
}

export const TUNE_DEFAULTS: Tune = { language: "", detail: "normal", places: "normal", lookups: 30, fixRounds: 1, thinking: "on", temperature: 0.4, keepAlive: "5m", pages: "known", search: "auto", localPlan: "whole" };

/** Only valid values; anything else falls back to what it was (or the default). */
function cleanTune(t: Partial<Tune> = {}, base: Tune = TUNE_DEFAULTS): Tune {
  const pick = <K extends keyof Tune>(k: K, ok: (v: unknown) => boolean) => (t[k] !== undefined && ok(t[k]) ? t[k]! : base[k]);
  return {
    language: pick("language", (v) => typeof v === "string" && v.length <= 40 && /^[\p{L} ()-]*$/u.test(v)),
    detail: pick("detail", (v) => ["brief", "normal", "detailed"].includes(v as string)),
    places: pick("places", (v) => ["fewer", "normal", "more"].includes(v as string)),
    lookups: Number(pick("lookups", (v) => [5, 10, 20, 30, 45].includes(Number(v)))),
    fixRounds: Number(pick("fixRounds", (v) => [0, 1, 2].includes(Number(v)))),
    thinking: pick("thinking", (v) => v === "on" || v === "off"),
    temperature: Math.round(Number(pick("temperature", (v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1)) * 100) / 100,
    keepAlive: pick("keepAlive", (v) => ["5m", "30m", "2h", "-1"].includes(v as string)),
    pages: pick("pages", (v) => ["found", "known", "any"].includes(v as string)),
    search: pick("search", (v) => ["auto", "brave", "searxng"].includes(v as string)),
    localPlan: pick("localPlan", (v) => ["whole", "steps"].includes(v as string)),
  };
}

const FILE = path.join(ROOT, "settings.json");
const CTX = [0, 16384, 32768, 65536, 131072, 196608, 262144];
export const newToken = () => crypto.randomBytes(18).toString("base64url");

export function readSettings(): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* none yet */ }
  return {
    window: saved.window === "browser" ? "browser" : "app",
    lan: saved.lan === true,
    lanToken: typeof saved.lanToken === "string" && saved.lanToken.length >= 16 ? saved.lanToken : "",
    numCtx: CTX.includes(Number(saved.numCtx)) ? Number(saved.numCtx) : 0,
    checkUpdates: saved.checkUpdates !== false,
    braveKey: typeof saved.braveKey === "string" ? saved.braveKey : "",
    searxngUrl: typeof saved.searxngUrl === "string" ? saved.searxngUrl : "",
    geoapifyKey: typeof saved.geoapifyKey === "string" ? saved.geoapifyKey : "",
    googleKey: typeof saved.googleKey === "string" ? saved.googleKey : "",
    quickstartSeen: saved.quickstartSeen === true,
    linesDir: typeof saved.linesDir === "string" ? saved.linesDir : "",
    tune: cleanTune(saved.tune),
    app: cleanApp(saved.app),
  };
}

/** The planning options in effect. */
export const tune = () => readSettings().tune;

export function writeSettings(next: Partial<Omit<Settings, "tune" | "app">> & { tune?: Partial<Tune>; app?: Partial<AppPrefs> }) {
  const now = readSettings();
  const s: Settings = {
    window: next.window === "app" || next.window === "browser" ? next.window : now.window,
    lan: typeof next.lan === "boolean" ? next.lan : now.lan,
    lanToken: typeof next.lanToken === "string" ? next.lanToken : now.lanToken,
    numCtx: next.numCtx != null && CTX.includes(Number(next.numCtx)) ? Number(next.numCtx) : now.numCtx,
    checkUpdates: typeof next.checkUpdates === "boolean" ? next.checkUpdates : now.checkUpdates,
    braveKey: typeof next.braveKey === "string" ? next.braveKey.trim().slice(0, 200) : now.braveKey,
    searxngUrl: typeof next.searxngUrl === "string" && (next.searxngUrl === "" || /^https?:\/\/[^\s]+$/.test(next.searxngUrl.trim())) ? next.searxngUrl.trim().replace(/\/+$/, "") : now.searxngUrl,
    geoapifyKey: typeof next.geoapifyKey === "string" ? next.geoapifyKey.trim().slice(0, 100) : now.geoapifyKey,
    googleKey: typeof next.googleKey === "string" ? next.googleKey.trim().slice(0, 100) : now.googleKey,
    quickstartSeen: typeof next.quickstartSeen === "boolean" ? next.quickstartSeen : now.quickstartSeen,
    // Set only through the lines' own call (it moves what's there first), never from the settings form.
    linesDir: typeof next.linesDir === "string" ? next.linesDir : now.linesDir,
    tune: next.tune ? cleanTune(next.tune, now.tune) : now.tune,
    app: next.app ? cleanApp({ ...now.app, ...next.app, newTrip: { ...now.app.newTrip, ...(next.app.newTrip || {}) } }, now.app) : now.app,
  };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}

/** The phone link's secret, made the first time it's needed. */
export function lanToken() {
  const s = readSettings();
  return s.lanToken || writeSettings({ lanToken: newToken() }).lanToken;
}

/** Ollama's keep_alive: "-1" (until Ollama stops) is the number -1 there. */
export const keepAlive = (v: string) => (v === "-1" ? -1 : v);
