// Stops a push that would publish something personal: run by .githooks/pre-push (turn it on once per clone with
// `git config core.hooksPath .githooks`). It looks at the commits about to be pushed (added lines, file names and
// messages) for files that hold your own data, API keys, and your own terms: those listed one per line in
// .private-terms (never committed), plus the hotels, home address, people and emails of the trips saved here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();

/** Files that are someone's own data wherever they are. */
export const OWN_DATA = /^(saves|lists|cache|backups|sync|backup-v1)\/|(^|\/)(current-trip|keys|settings|gemini-usage)\.json$|\.(csv|log|env)$|(^|\/)\.private-terms$/i;
/** Real-looking keys (the tests' made-up ones say "abcdefg"). */
const KEYS = /AIza[0-9A-Za-z_-]{35}|sk-(ant-|or-|proj-)?[A-Za-z0-9_-]{32,}|GOCSPX-(?!abcdefg)[A-Za-z0-9_-]{20,}/;

function fromTrips() {
  const terms = new Set();
  const dirs = [root, path.join(root, "saves")];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "Trip Planner"), path.join(process.env.APPDATA, "Trip Planner", "saves"));
  const add = (v) => { const t = String(v || "").split(",")[0].replace(/^(around|near) (the )?/i, "").trim(); if (t.length >= 5) terms.add(t); };
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => (/[\\/]saves$/.test(dir) ? f.endsWith(".json") : f === "current-trip.json"))) {
      let trip;
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); trip = j.state || j; } catch { continue; }
      for (const s of trip.stays || []) { add(s.hotel); if (!Number(s.nights)) add(s.city); }
      for (const p of Array.isArray(trip.people) ? trip.people : Object.keys(trip.people || {})) add(typeof p === "string" ? p : p?.name);
      add(trip.sync?.owner); add(trip.sync?.ownerName);
    }
  }
  return terms;
}

function ownTerms() {
  const file = path.join(root, ".private-terms");
  const listed = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  return [...new Set([...listed, ...fromTrips()])];
}

/** What's wrong with the commits in `range` (git revision arguments). */
function check(range) {
  const terms = ownTerms().map((t) => ({ t, re: new RegExp(`(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu") }));
  const found = new Set();
  const look = (text, where) => {
    if (KEYS.test(text)) found.add(`${where}: looks like an API key`);
    for (const { t, re } of terms) if (re.test(text)) found.add(`${where}: "${t}"`);
  };
  for (const commit of git("rev-list", ...range).split("\n").filter(Boolean)) {
    const short = commit.slice(0, 7);
    look(git("log", "-1", "--format=%B%n%an %ae %cn %ce", commit), `${short} message`);
    // Added and changed files only: deleting something personal is fine.
    for (const file of git("diff-tree", "--root", "-r", "-z", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", commit).split("\0").filter(Boolean)) {
      if (OWN_DATA.test(file)) found.add(`${short} ${file}: a file with your own data`);
      look(file, `${short} file name`);
    }
    let file = "";
    for (const line of git("show", "--format=", "--no-color", "--unified=0", commit, "--", ".", ":!package-lock.json").split("\n")) {
      if (line.startsWith("+++ ")) file = line.slice(6);
      else if (line.startsWith("+")) look(line.slice(1), `${short} ${file}`);
    }
  }
  return [...found];
}

// As a pre-push hook, git gives "<ref> <commit> <remote ref> <remote commit>" lines; by hand, the commits not pushed yet.
const input = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
const heads = input.split("\n").map((l) => l.split(" ")[1]).filter((sha) => sha && !/^0+$/.test(sha));
if (!input || heads.length) {
  const problems = check([...(heads.length ? heads : ["HEAD"]), "--not", "--remotes"]);
  if (problems.length) {
    console.error(`Not pushed: this would publish something personal.\n  ${problems.slice(0, 40).join("\n  ")}`);
    console.error("Take it out of those commits. If one is a false alarm, change the term in .private-terms or the check itself.");
    process.exit(1);
  }
}
