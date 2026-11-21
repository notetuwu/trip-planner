// App settings kept in the data folder (settings.json): for now, whether the app opens in its own window or a browser tab.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";

export type WindowMode = "app" | "browser";
export interface Settings { window: WindowMode }

const FILE = path.join(ROOT, "settings.json");

export function readSettings(): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* none yet */ }
  return { window: saved.window === "browser" ? "browser" : "app" };
}

export function writeSettings(next: Partial<Settings>) {
  const s = { ...readSettings(), ...next };
  if (s.window !== "app" && s.window !== "browser") s.window = "app";
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  return s;
}
