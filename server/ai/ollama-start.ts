// Starts an installed Ollama that isn't running (its tray app was closed, or it didn't start with the computer), and
// reports the graphics memory for the local-model guide. Only an Ollama that's already installed is ever started.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GpuInfo } from "../../shared/types";
import { getJson } from "../util/http";
import { OLLAMA_URL } from "./local-models";

/** How to start Ollama here: [command, args], or null if it isn't installed where Ollama puts itself. */
function ollamaLauncher(): [string, string[]] | null {
  const exists = (p: string) => { try { return fs.statSync(p).isFile() || fs.statSync(p).isDirectory(); } catch { return false; } };
  if (process.platform === "win32") {
    for (const dir of [path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama"), path.join(process.env.ProgramFiles || "", "Ollama")]) {
      if (exists(path.join(dir, "ollama app.exe"))) return [path.join(dir, "ollama app.exe"), []]; // the tray app starts the server
      if (exists(path.join(dir, "ollama.exe"))) return [path.join(dir, "ollama.exe"), ["serve"]];
    }
    return null;
  }
  if (process.platform === "darwin") {
    for (const app of ["/Applications/Ollama.app", path.join(os.homedir(), "Applications", "Ollama.app")]) if (exists(app)) return ["open", ["-a", app]];
  }
  for (const dir of ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin")]) {
    if (exists(path.join(dir, "ollama"))) return [path.join(dir, "ollama"), ["serve"]];
  }
  return null;
}

export const ollamaInstalled = () => !!ollamaLauncher();
const running = () => getJson(`${OLLAMA_URL}/api/tags`, 800).then(() => true, () => false);

let starting: Promise<boolean> | null = null, lastTry = 0;

/** Makes sure Ollama answers: starts it if it's installed but not running (at most every 2 minutes). Waits up to ~15 s. */
export function ensureOllama(): Promise<boolean> {
  if (starting) return starting;
  starting = (async () => {
    if (await running()) return true;
    // Only the default local address: a custom OLLAMA_URL may be another machine.
    const launcher = /^http:\/\/(127\.0\.0\.1|localhost):11434$/.test(OLLAMA_URL) ? ollamaLauncher() : null;
    if (!launcher || Date.now() - lastTry < 120_000) return false;
    lastTry = Date.now();
    console.log("Ollama is installed but not running; starting it.");
    try { spawn(launcher[0], launcher[1], { stdio: "ignore", detached: true, windowsHide: true }).unref(); } catch { return false; }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await running()) { console.log("Ollama is running."); return true; }
    }
    return false;
  })().finally(() => { starting = null; });
  return starting;
}


/** The graphics card and its memory (NVIDIA via nvidia-smi), or a Mac's unified memory; null if unknown. */
export function gpuInfo(): Promise<GpuInfo | null> {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return Promise.resolve({ name: "Apple Silicon (shared memory)", memGb: Math.round(os.totalmem() / 1024 ** 3), unified: true });
  }
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const [name, mib] = String(out).trim().split("\n")[0].split(",").map((s) => s.trim());
      resolve(name && Number(mib) ? { name, memGb: Math.round(Number(mib) / 1024) } : null);
    });
  });
}
