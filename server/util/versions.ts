// Earlier versions of saved trips, and copies of the open trip that was replaced. Saving overwrites a file, and opening
// another trip replaces the one on screen: both used to throw the old state away. Now:
//  - Before a save is overwritten, its old content is kept in saves/.history/<name>/ (at most one every 10 minutes while
//    it's being changed, so 40 versions reach back hours, not minutes; a save the person made by hand always keeps one).
//  - When the trip on screen is about to be replaced (another trip opened, a new one started, a file imported) and it has
//    changes nobody saved, a copy goes to saves/.rescue/.
// Both folders start with a dot, so the list of saved trips doesn't show them.
import fs from "node:fs";
import path from "node:path";

export const MAX_VERSIONS = 40, MIN_GAP_MS = 10 * 60_000, MAX_RESCUE = 20;

/** Stable text of a value (keys sorted), to tell whether two trips are the same. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sameText = (a: string, b: string) => { try { return stable(JSON.parse(a)) === stable(JSON.parse(b)); } catch { return a === b; } };

/** The numbered files in a folder, newest first. */
function stamps(dir: string): number[] {
  try { return fs.readdirSync(dir).map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter((x): x is string => !!x).map(Number).sort((a, b) => b - a); } catch { return []; }
}
/** A new file name in a folder: the time, or the next number when that's taken. */
function nextStamp(dir: string) {
  let t = Date.now();
  while (fs.existsSync(path.join(dir, `${t}.json`))) t++;
  return t;
}
function prune(dir: string, keep: number) {
  for (const t of stamps(dir).slice(keep)) { try { fs.unlinkSync(path.join(dir, `${t}.json`)); } catch { /* already gone */ } }
}

/** What a trip is made of, for a list: its towns, days and stops. */
export function summary(text: string) {
  try {
    const t = JSON.parse(text), days = t?.itinerary?.days || [];
    return {
      cities: (t.stays || []).map((s: { city?: string }) => String(s.city || "").split(",")[0]).filter(Boolean).slice(0, 4) as string[],
      days: days.length as number, items: days.reduce((n: number, d: { items?: unknown[] }) => n + (d.items?.length || 0), 0) as number,
      chat: (t.chat || []).length as number, name: String(t.saveName || ""),
    };
  } catch { return { cities: [], days: 0, items: 0, chat: 0, name: "" }; }
}

// ---- Versions of a saved trip ---------------------------------------------------------------------------------------------
const histDir = (root: string, name: string) => path.join(root, ".history", name);

/**
 * Keeps what a save holds now, before it's overwritten. `force` (a save made by hand) keeps one whatever the last was;
 * otherwise one is kept only when the newest is 10 minutes old. Nothing is kept when the content is the same.
 */
export function keepVersion(root: string, name: string, file: string, force = false): boolean {
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file, "utf8"), dir = histDir(root, name), [newest] = stamps(dir);
  if (newest != null) {
    if (!force && Date.now() - newest < MIN_GAP_MS) return false;
    if (sameText(fs.readFileSync(path.join(dir, `${newest}.json`), "utf8"), body)) return false;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${nextStamp(dir)}.json`), body);
  prune(dir, MAX_VERSIONS);
  return true;
}

/** Keeps a trip that isn't the save's content as one of its versions (the other side's copy, before sync replaces it with
 *  this computer's). Nothing is kept when it's the same as the newest version. */
export function keepVersionText(root: string, name: string, text: string): boolean {
  const dir = histDir(root, name), [newest] = stamps(dir);
  if (newest != null && sameText(fs.readFileSync(path.join(dir, `${newest}.json`), "utf8"), text)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${nextStamp(dir)}.json`), text);
  prune(dir, MAX_VERSIONS);
  return true;
}

export function listVersions(root: string, name: string) {
  const dir = histDir(root, name);
  return stamps(dir).map((t) => {
    const text = fs.readFileSync(path.join(dir, `${t}.json`), "utf8");
    return { id: String(t), savedAt: new Date(t).toISOString(), size: text.length, ...summary(text) };
  });
}
/** The newest version from before a change made at `at`: what the save held then (the version kept by the save that made
 *  the change is stamped a moment after it). */
export function versionBefore(root: string, name: string, at: number): { savedAt: string; text: string } | null {
  const dir = histDir(root, name), t = stamps(dir).find((s) => s <= at + 5000);
  if (t == null) return null;
  try { return { savedAt: new Date(t).toISOString(), text: fs.readFileSync(path.join(dir, `${t}.json`), "utf8") }; } catch { return null; }
}

// ---- What a part held before a change (for putting one change back, from the history of changes) ---------------------------
export const MAX_PARTS = 400;
const partsDir = (root: string, name: string) => path.join(histDir(root, name), "parts");
const partFile = (was: string, key: string) => `${was}-${key.replace(/[^\w-]/g, "_").slice(0, 80)}.json`;

/** Keeps what a part held before the change named `was` (shared/edits.ts: Change.was); the oldest go past MAX_PARTS. */
export function keepPart(root: string, name: string, was: string, key: string, before: unknown) {
  if (!/^\d+$/.test(was)) return;
  const dir = partsDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, partFile(was, key)), JSON.stringify(before ?? {}));
  const files = fs.readdirSync(dir).filter((f) => /^\d+-/.test(f)).sort((a, b) => parseInt(b) - parseInt(a));
  for (const f of files.slice(MAX_PARTS)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* already gone */ } }
}
/** What the part holds after the change, noted again when the same change goes on (changes joined into one). Left alone
 *  when what's kept is of the other kind (a part against a whole plan). */
export function setPartAfter(root: string, name: string, was: string, key: string, after: unknown, whole: boolean) {
  const text = readPart(root, name, was, key);
  if (text == null) return;
  try {
    const kept = JSON.parse(text);
    if (!!kept.whole !== whole) return;
    fs.writeFileSync(path.join(partsDir(root, name), partFile(was, key)), JSON.stringify({ ...kept, after }));
  } catch { /* unreadable: left */ }
}
export function readPart(root: string, name: string, was: string, key: string): string | null {
  if (!/^\d+$/.test(was)) return null;
  try { return fs.readFileSync(path.join(partsDir(root, name), partFile(was, key)), "utf8"); } catch { return null; }
}

export function readVersion(root: string, name: string, id: string): string | null {
  if (!/^\d+$/.test(id)) return null;
  try { return fs.readFileSync(path.join(histDir(root, name), `${id}.json`), "utf8"); } catch { return null; }
}
/** Every save that has versions, with how many. */
export function versionedNames(root: string): string[] {
  try { return fs.readdirSync(path.join(root, ".history"), { withFileTypes: true }).filter((e) => e.isDirectory() && stamps(path.join(root, ".history", e.name)).length).map((e) => e.name); } catch { return []; }
}

// ---- Copies of the open trip when it's replaced ----------------------------------------------------------------------------
const rescueDir = (root: string) => path.join(root, ".rescue");

/** Whether a trip has anything in it (an empty new trip isn't worth a copy). */
export function worthKeeping(trip: any): boolean {
  return !!(trip && (trip.itinerary?.days?.length || trip.stays?.some((s: { city?: string }) => s?.city) || Object.keys(trip.marks || {}).length || trip.chat?.length || trip.ideas?.trim?.() || trip.photoFolders?.length));
}

/** Keeps a copy of the trip on screen, unless it has nothing in it, or is exactly what its save holds (nothing would be lost),
 *  or is the same as the last copy. Returns whether one was kept. */
export function keepRescue(root: string, trip: any, savesDir = root): boolean {
  if (!worthKeeping(trip)) return false;
  const name = String(trip.saveName || "");
  if (name) {
    try { if (sameText(fs.readFileSync(path.join(savesDir, `${name}.json`), "utf8"), JSON.stringify(trip))) return false; } catch { /* no such save: it's unsaved */ }
  }
  const dir = rescueDir(root), text = JSON.stringify(trip), [newest] = stamps(dir);
  if (newest != null && sameText(fs.readFileSync(path.join(dir, `${newest}.json`), "utf8"), text)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${nextStamp(dir)}.json`), text);
  prune(dir, MAX_RESCUE);
  return true;
}
export function listRescue(root: string) {
  const dir = rescueDir(root);
  return stamps(dir).map((t) => {
    const text = fs.readFileSync(path.join(dir, `${t}.json`), "utf8");
    return { id: String(t), savedAt: new Date(t).toISOString(), size: text.length, ...summary(text) };
  });
}
export function readRescue(root: string, id: string): string | null {
  if (!/^\d+$/.test(id)) return null;
  try { return fs.readFileSync(path.join(rescueDir(root), `${id}.json`), "utf8"); } catch { return null; }
}
