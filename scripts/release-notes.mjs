// Writes the release notes for a version tag: "What's new" from the commit messages since the previous version, then
// how to download and run it. Used by the release workflow:  node scripts/release-notes.mjs v3.5.0 > notes.md
import { execFileSync } from "node:child_process";
import { LOG_FORMAT, isNews, parseCommits } from "./changelog.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tag = process.argv[2] || git("describe", "--tags", "--abbrev=0");

let previous = "";
try { previous = git("describe", "--tags", "--abbrev=0", `${tag}^`); } catch { /* the first release */ }

const commits = parseCommits(git("log", LOG_FORMAT, previous ? `${previous}..${tag}` : tag)).filter(isNews);

// A heading per change, its introduction, then its points (grouped under small headings when the commit groups them).
const section = (c) => [
  `### ${c.subject}`,
  ...(c.intro ? ["", c.intro] : []),
  ...c.groups.flatMap((g) => ["", ...(g.head ? [`**${g.head}**`, ""] : []), ...g.points.map((p) => `- ${p}`)]),
].join("\n");
const whatsNew = commits.map(section).join("\n\n");
const version = tag.replace(/^v/, "");
const date = (() => { try { return git("log", "-1", "--format=%cs", tag); } catch { return ""; } })();

process.stdout.write(`## What's new in ${version}${date ? ` <sub>${date}</sub>` : ""}

${whatsNew || "Small fixes."}

---

## Download

| | File | Then |
|---|---|---|
| **Windows** | \`…-windows-x64-setup.exe\` (installer) or \`…-windows-x64-portable.zip\` | Run the installer, or unzip and run \`Trip Planner.exe\`. Already installed? The app offers the update itself. |
| **macOS** | \`…-macos-arm64.zip\` (Apple Silicon) or \`…-macos-x64.zip\` (Intel) | Unzip and move Trip Planner to Applications. |
| **Linux** | \`…-linux-x64.tar.gz\` | Unpack and run \`trip-planner\`. |

> [!NOTE]
> The app isn't code-signed yet. Windows may show "Windows protected your PC": click **More info → Run anyway**. On macOS, right-click the app → **Open** the first time (or allow it under System Settings → Privacy & Security).

For planning you need [Claude Code](https://claude.com/claude-code) (logged in), a local model server such as [Ollama](https://ollama.com), or an API key (API keys in the app).
${previous ? `\n**All changes:** https://github.com/notetuwu/trip-planner/compare/${previous}...${tag}\n` : ""}`);
