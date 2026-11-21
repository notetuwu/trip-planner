// Writes the release notes for a version tag: "What's new" from the commit messages since the previous version, then
// how to download and run it. Used by the release workflow:  node scripts/release-notes.mjs v3.5.0 > notes.md
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tag = process.argv[2] || git("describe", "--tags", "--abbrev=0");

let previous = "";
try { previous = git("describe", "--tags", "--abbrev=0", `${tag}^`); } catch { /* the first release */ }

// Each commit: subject, then body (separated by markers that won't appear in messages).
const log = git("log", "--format=%x1e%s%x1f%b", previous ? `${previous}..${tag}` : tag);
const commits = log.split("\x1e").filter((c) => c.trim()).map((c) => {
  const [subject, body = ""] = c.split("\x1f");
  return {
    // "…; version 3.5.0" says nothing new on the release page.
    subject: subject.trim().replace(/;?\s*version \d+\.\d+\.\d+\s*$/i, "").trim(),
    points: body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2)),
  };
}).filter((c) => c.subject && !/^(merge|bump)\b/i.test(c.subject));

const whatsNew = commits.map((c) => [`- **${c.subject}**`, ...c.points.map((p) => `  - ${p}`)].join("\n")).join("\n");

process.stdout.write(`## What's new
${whatsNew || "- Small fixes."}

## Download
- **Windows:** \`…-windows-x64-setup.exe\` (installer) or \`…-windows-x64-portable.zip\` (no install; unzip and run \`Trip Planner.exe\`). Already installed? The app offers the update itself.
- **macOS:** \`…-macos-arm64.zip\` (Apple Silicon) or \`…-macos-x64.zip\` (Intel); unzip and move Trip Planner to Applications
- **Linux:** \`…-linux-x64.tar.gz\`; unpack and run \`trip-planner\`

The app isn't code-signed yet. Windows may show "Windows protected your PC": click **More info → Run anyway**. On macOS, right-click the app → **Open** the first time (or allow it under System Settings → Privacy & Security).

For planning you need [Claude Code](https://claude.com/claude-code) (logged in), a local model server such as [Ollama](https://ollama.com), or an API key (API keys in the app).
${previous ? `\n**All changes:** https://github.com/notetuwu/trip-planner/compare/${previous}...${tag}\n` : ""}`);
