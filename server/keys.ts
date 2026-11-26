// API keys for cloud models. Environment variables (also from a .env file in the data folder) win; keys entered on
// the page are kept in keys.json next to saves/ (gitignored). Keys never go to the browser: it only sees whether one
// is set and its last few characters.
import fs from "node:fs";
import path from "node:path";
import type { CloudProvider, KeyStatus } from "../shared/types";
import { ROOT } from "./config";

export const PROVIDERS: Record<CloudProvider, { env: string; name: string }> = {
  anthropic: { env: "ANTHROPIC_API_KEY", name: "Anthropic" },
  openai: { env: "OPENAI_API_KEY", name: "OpenAI" },
  openrouter: { env: "OPENROUTER_API_KEY", name: "OpenRouter" },
  gemini: { env: "GEMINI_API_KEY", name: "Google Gemini" },
};
export const isProvider = (p: string): p is CloudProvider => p in PROVIDERS;

const KEYS_FILE = path.join(ROOT, "keys.json");
const ENV_FILE = path.join(ROOT, ".env");

/** Loads .env once at startup (existing environment variables are kept). */
export function loadEnvFile() {
  try { if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE); }
  catch (e) { console.warn(`Could not read ${ENV_FILE}: ${(e as Error).message}`); }
}

function readFile(): Partial<Record<CloudProvider, string>> {
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); } catch { return {}; }
}

export function getKey(p: CloudProvider): string {
  return (process.env[PROVIDERS[p].env] || "").trim() || (readFile()[p] || "").trim();
}

/** Saves (or with an empty key, removes) a key entered on the page. */
export function setKey(p: CloudProvider, key: string) {
  const keys = readFile();
  if (key.trim()) keys[p] = key.trim(); else delete keys[p];
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

export function keyStatus(): Record<CloudProvider, KeyStatus> {
  const file = readFile();
  const status = (p: CloudProvider): KeyStatus => {
    const env = (process.env[PROVIDERS[p].env] || "").trim();
    const key = env || (file[p] || "").trim();
    return { set: !!key, source: env ? "env" : key ? "file" : "", hint: key ? `…${key.slice(-4)}` : "" };
  };
  return Object.fromEntries((Object.keys(PROVIDERS) as CloudProvider[]).map((p) => [p, status(p)])) as Record<CloudProvider, KeyStatus>;
}
