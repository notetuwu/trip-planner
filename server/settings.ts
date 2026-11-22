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
  };
}

export function writeSettings(next: Partial<Settings>) {
  const now = readSettings();
  const s: Settings = {
    window: next.window === "app" || next.window === "browser" ? next.window : now.window,
    lan: typeof next.lan === "boolean" ? next.lan : now.lan,
    lanToken: typeof next.lanToken === "string" ? next.lanToken : now.lanToken,
    numCtx: next.numCtx != null && CTX.includes(Number(next.numCtx)) ? Number(next.numCtx) : now.numCtx,
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
