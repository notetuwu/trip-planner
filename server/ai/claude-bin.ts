// Finds the Claude Code CLI: CLAUDE_BIN, then the PATH, then the binary bundled with the VS Code extension.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findClaude(): string | null {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
    const exe = out.find((p) => /\.exe$/i.test(p)) || out[0];
    if (exe) return exe;
  } catch { /* not on the PATH */ }
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
