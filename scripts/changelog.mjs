// Reads what changed in each version from the commit messages: for the release pages (release-notes.mjs) and for the
// update log built into the app (Settings → Updates; see vite.config.ts).
import { execFileSync } from "node:child_process";

/** git log's format for parseCommits: date, the tags and branches on the commit, then the whole message. */
export const LOG_FORMAT = "--format=%x1e%cs%x1f%D%x1f%B";

/** The commits of a `git log` in LOG_FORMAT. The first line is the subject; in the rest, "- " lines are points, a short
 *  line ending in ":" ("Map:") starts a group of points under that heading, and other lines before the first point are
 *  an introduction. */
export function parseCommits(log) {
  return log.split("\x1e").filter((c) => c.trim()).map((c) => {
    const [date, refs, message = ""] = c.split("\x1f");
    const [first = "", ...body] = message.trim().split("\n");
    // A message written without the empty line after its subject may have run into one line: the subject ends at the
    // version.
    const [, subject = first, rest = ""] = first.match(/^(.*?version \d+\.\d+\.\d+)\s+(\S.*)$/i) || [];
    const groups = [{ head: "", points: [] }], intro = [];
    for (const raw of [...(rest ? [rest] : []), ...body]) {
      const l = raw.trim();
      if (!l || /^co-authored-by:/i.test(l)) continue;
      if (l.startsWith("- ")) groups[groups.length - 1].points.push(l.slice(2));
      else if (/^[^-].{0,40}:$/.test(l)) groups.push({ head: l.slice(0, -1), points: [] });
      else if (groups.length === 1 && !groups[0].points.length) intro.push(l);
    }
    return {
      date,
      // The version this commit completes: its tag, else the one its subject names.
      version: refs.match(/tag: v(\d+\.\d+\.\d+)/)?.[1] || subject.match(/version (\d+\.\d+\.\d+)\s*$/i)?.[1] || "",
      // "…; version 3.5.0" says nothing new next to the version.
      subject: subject.trim().replace(/;?\s*version \d+\.\d+\.\d+\s*$/i, "").trim(),
      intro: intro.join(" "),
      groups: groups.filter((g) => g.points.length),
    };
  });
}

/** Commits worth telling about. */
export const isNews = (c) => !!c.subject && !/^(merge|bump)\b/i.test(c.subject);

/** Every version with its changes, newest first. `commits` are oldest first; those after the last version aren't in one
 *  yet and are left out. */
export function releases(commits) {
  const out = [];
  let waiting = [];
  for (const c of commits) {
    if (isNews(c)) waiting.push(c);
    if (!c.version) continue;
    out.push({ version: c.version, date: c.date, changes: waiting.map(({ subject, intro, groups }) => ({ subject, intro, groups })) });
    waiting = [];
  }
  return out.reverse();
}

/** The update log of the repository in `cwd`; empty without git or its history (a downloaded source archive). */
export function readChangelog(cwd) {
  try {
    const log = execFileSync("git", ["log", "--reverse", "--decorate=short", LOG_FORMAT], { cwd, encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] });
    return releases(parseCommits(log));
  } catch { return []; }
}
