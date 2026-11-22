// Finds the Claude Code CLI: CLAUDE_BIN, then the PATH, then the usual install folders, then the binary bundled with
// the VS Code extension.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let found: { bin: string | null; at: number } | null = null;

/** Remembered: found once for good, not found for half a minute (it may be installed meanwhile). */
export function findClaude(): string | null {
  if (found && (found.bin || Date.now() - found.at < 30_000)) return found.bin;
  found = { bin: lookUp(), at: Date.now() };
  return found.bin;
}

function lookUp(): string | null {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    // Hidden: the app has no console of its own, so a console program would flash up a cmd window.
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 }).split(/\r?\n/).filter(Boolean);
    const exe = out.find((p) => /\.exe$/i.test(p)) || out[0];
    if (exe) return exe;
  } catch { /* not on the PATH */ }
  // The usual install locations (apps started from the Finder or a shortcut don't get the terminal's PATH).
  const home = os.homedir();
  const usual = process.platform === "win32"
    ? [path.join(home, ".local", "bin", "claude.exe"), path.join(home, ".claude", "local", "claude.exe")]
    : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const usualHit = usual.find((p) => fs.existsSync(p));
  if (usualHit) return usualHit;
  // The VS Code extension ships its own binary (newest version wins).
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  try {
    const bin = process.platform === "win32" ? "claude.exe" : "claude";
    const candidates = fs.readdirSync(extDir)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(extDir, d, "resources", "native-binary", bin))
      .filter((p) => fs.existsSync(p));
    if (candidates[0]) return candidates[0];
  } catch { /* no extension */ }
  return null;
}
