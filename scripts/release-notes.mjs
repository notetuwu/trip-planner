// Writes the release notes for a version tag: "What's new" from the commit messages since the previous version, then
// how to download and run it. Used by the release workflow:  node scripts/release-notes.mjs v3.5.0 > notes.md
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const tag = process.argv[2] || git("describe", "--tags", "--abbrev=0");

let previous = "";
try { previous = git("describe", "--tags", "--abbrev=0", `${tag}^`); } catch { /* the first release */ }

// Each commit: subject, then body (separated by markers that won't appear in messages). In the body, "- " lines are
// points; a short line ending in ":" ("Map:") starts a group of points under that heading; other lines before the first
// point are an introduction.
const log = git("log", "--format=%x1e%s%x1f%b", previous ? `${previous}..${tag}` : tag);
const commits = log.split("\x1e").filter((c) => c.trim()).map((c) => {
  const [subject, body = ""] = c.split("\x1f");
  const groups = [{ head: "", points: [] }], intro = [];
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (!l || /^co-authored-by:/i.test(l)) continue;
    if (l.startsWith("- ")) groups[groups.length - 1].points.push(l.slice(2));
    else if (/^[^-].{0,40}:$/.test(l)) groups.push({ head: l.slice(0, -1), points: [] });
    else if (groups.length === 1 && !groups[0].points.length) intro.push(l);
  }
  return {
    // "…; version 3.5.0" says nothing new on the release page.
    subject: subject.trim().replace(/;?\s*version \d+\.\d+\.\d+\s*$/i, "").trim(),
    intro: intro.join(" "),
    groups: groups.filter((g) => g.points.length),
  };
}).filter((c) => c.subject && !/^(merge|bump)\b/i.test(c.subject));

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
