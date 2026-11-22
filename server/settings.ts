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
  tune: Tune;
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
}

export const TUNE_DEFAULTS: Tune = { language: "", detail: "normal", places: "normal", lookups: 30, fixRounds: 1, thinking: "on", temperature: 0.4, keepAlive: "5m" };

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
    tune: cleanTune(saved.tune),
  };
}

/** The planning options in effect. */
export const tune = () => readSettings().tune;

export function writeSettings(next: Partial<Omit<Settings, "tune">> & { tune?: Partial<Tune> }) {
  const now = readSettings();
  const s: Settings = {
    window: next.window === "app" || next.window === "browser" ? next.window : now.window,
    lan: typeof next.lan === "boolean" ? next.lan : now.lan,
    lanToken: typeof next.lanToken === "string" ? next.lanToken : now.lanToken,
    numCtx: next.numCtx != null && CTX.includes(Number(next.numCtx)) ? Number(next.numCtx) : now.numCtx,
    checkUpdates: typeof next.checkUpdates === "boolean" ? next.checkUpdates : now.checkUpdates,
    tune: next.tune ? cleanTune(next.tune, now.tune) : now.tune,
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
