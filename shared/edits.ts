// Who changed which part of a trip last, and when: for trips several people work on (synced through a folder). The trip
// is cut into parts (its stays, each day of the plan, each photo placed by hand, the bookings…); a save that changes a
// part stamps it with who and when (server/routes/saves.ts). The stamps travel with the trip, so everyone sees them, and
// are joined newest-wins when two sides' changes are joined (they never clash). Also what changed between two versions of
// a trip, in words, for "changed while you had it open". No page or server code here, so it can be tested.
import { merge3, same } from "./merge";

export interface Edit {
  /** The name to show ("Lena"). */
  by: string;
  /** Who it is (their Google account, or this computer's user), to tell one's own changes from others'. */
  id?: string;
  /** When (ms since 1970). */
  at: number;
}
export type Edits = Record<string, Edit>;

/** What's each person's own, not the trip's: their trip chat (kept on their computer; the changes it makes to the plan are
 *  the trip's like any other), the models they plan and chat with (which may not exist on another computer), what the trip
 *  chat may do by itself, and how plans are made. Kept out of the file shared through a folder, and never taken from it. */
export const PERSONAL = ["chat", "chatSummary", "chatSummarized", "model", "chatModel", "routeModel", "routePlan", "research", "autoFix", "hoursOnline", "chatMode"] as const;

const DETAILS = ["travelers", "people", "dailyBudget", "budgetPer", "currency", "pace", "fitness", "dayStart", "breakfast", "getAround", "interests", "wishes", "notes", "car", "lastRouteWhat"];
const PLACES = ["marks", "who", "how", "customPlaces", "kept", "lists", "list", "listSuggest", "listChosen"];
const PACKING = ["packed", "packingExtra"];
/** Parts that are a few of the trip's own fields together. */
const GROUPS: Record<string, string[]> = { details: DETAILS, places: PLACES, packing: PACKING };
/** Parts that are one field of the trip. */
const FIELDS: Record<string, string> = { stays: "stays", bookings: "bookings", bookahead: "booked", ideas: "ideas" };

type Trip = Record<string, any>;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const pick = (t: Trip, keys: string[]) => { const o: Trip = {}; for (const k of keys) if (t[k] !== undefined) o[k] = t[k]; return Object.keys(o).length ? o : undefined; };

/** A day's part: by its date (the same day stays the same part when days before it change), or its place in the plan when
 *  it has no date or shares it. */
export function dayKey(days: { date?: string }[], i: number): string {
  const d = days[i]?.date || "";
  return d && days.filter((x) => x?.date === d).length === 1 ? `day:${d}` : `day:#${i}`;
}

/** The trip in parts, by key. */
export function partsOf(trip: Trip | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObj(trip)) return out;
  for (const [k, f] of Object.entries(FIELDS)) if (trip[f] !== undefined) out[k] = trip[f];
  for (const [k, keys] of Object.entries(GROUPS)) { const v = pick(trip, keys); if (v) out[k] = v; }
  if (Array.isArray(trip.photoFolders) && trip.photoFolders.length) out.photoFolders = trip.photoFolders.map((f: any) => f?.link);
  const it = trip.itinerary;
  if (isObj(it)) {
    const { days, ...plan } = it;
    out.plan = { ...plan, ...(trip.okRepeats ? { okRepeats: trip.okRepeats } : {}) };
    if (Array.isArray(days)) days.forEach((d, i) => { out[dayKey(days, i)] = d; });
  }
  if (isObj(trip.photoSpots)) for (const [k, v] of Object.entries(trip.photoSpots)) out[`photo:${k}`] = v;
  return out;
}

/** The parts that differ between two versions of a trip. */
export function changedParts(before: Trip | null | undefined, after: Trip | null | undefined): string[] {
  const a = partsOf(before), b = partsOf(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
}

/** Each part's newest stamp of several sets. */
export function joinEdits(...sets: (Edits | null | undefined)[]): Edits {
  const out: Edits = {};
  for (const s of sets) {
    if (!isObj(s)) continue;
    for (const [k, e] of Object.entries(s)) {
      if (!isObj(e) || typeof e.at !== "number" || typeof e.by !== "string") continue;
      if (!out[k] || out[k].at < e.at) out[k] = { by: e.by.slice(0, 120), ...(typeof e.id === "string" ? { id: e.id.slice(0, 200) } : {}), at: e.at };
    }
  }
  return out;
}

/** The stamps for a trip saved as `after` over `before`: what both had, and the parts that changed stamped as `who`'s
 *  now. A trip saved for the first time gets none (when its parts were made isn't known). Days no longer in the plan lose
 *  theirs. */
export function stamp(before: Trip | null | undefined, after: Trip, who: { by: string; id?: string }, at = Date.now()): Edits | undefined {
  if (!isObj(before)) return isObj(after.edits) ? joinEdits(after.edits) : undefined;
  const edits = joinEdits(before.edits, after.edits);
  for (const k of changedParts(before, after)) edits[k] = { by: who.by, ...(who.id ? { id: who.id } : {}), at };
  const now = partsOf(after);
  for (const k of Object.keys(edits)) if (k.startsWith("day:") && !(k in now)) delete edits[k];
  return Object.keys(edits).length ? edits : undefined;
}

// ---- The history of changes -----------------------------------------------------------------------------------------------
/** One change in the trip's history: which part, who, when, in words; for a photo also where it was and where it went. */
export interface Change {
  key: string;
  by: string;
  id?: string;
  at: number;
  /** In words ("added Gion", "moved"). */
  what: string;
  /** A photo's spot before and after (unset: none). */
  from?: unknown;
  to?: unknown;
}
/** How many changes the trip keeps (the oldest go first). */
export const LOG_MAX = 400;
/** Changes to the same part by the same person this close together are one (saving every few seconds while typing). */
const LOG_JOIN_MS = 10 * 60_000;
/** More days than this changed at once (a new plan, a re-planned stay): one change, not one per day. */
const MANY_DAYS = 4;

const okChange = (c: any): c is Change => isObj(c) && typeof c.key === "string" && typeof c.by === "string" && typeof c.at === "number" && typeof c.what === "string";
const changeId = (c: Change) => `${c.key}|${c.id || c.by}|${c.at}`;

/** Two histories as one: every change once, oldest first, the newest LOG_MAX. */
export function joinLogs(...logs: (Change[] | null | undefined)[]): Change[] {
  const seen = new Map<string, Change>();
  for (const l of logs) if (Array.isArray(l)) for (const c of l) if (okChange(c)) seen.set(changeId(c), c);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-LOG_MAX);
}

const joinWords = (a: string, b: string) => [...new Set([...a.split("; "), ...b.split("; ")].filter(Boolean))].join("; ").slice(0, 240);

/** The history with the changes from `before` to `after` added, as `who`'s now. */
export function logChanges(before: Trip, after: Trip, who: { by: string; id?: string }, at = Date.now()): Change[] {
  const log = joinLogs(before.log, after.log);
  const a = partsOf(before), b = partsOf(after), keys = changedParts(before, after);
  const days = keys.filter((k) => k.startsWith("day:"));
  const add = (c: Change) => {
    // The same person changing the same part again soon after: one change (a photo keeps where it was at first).
    const last = [...log].reverse().find((x) => x.key === c.key);
    if (last && (last.id || last.by) === (c.id || c.by) && c.at - last.at < LOG_JOIN_MS && log.indexOf(last) >= log.length - 20) {
      log.splice(log.indexOf(last), 1);
      c = c.key.startsWith("photo:")
        ? { ...c, from: last.from, what: describePart(c.key, last.from, c.to) }
        : { ...c, what: joinWords(last.what, c.what) };
      if (c.key.startsWith("photo:") && same(c.from, c.to)) return; // moved back where it was
    }
    log.push(c);
  };
  const me = { by: who.by, ...(who.id ? { id: who.id } : {}), at };
  if (days.length > MANY_DAYS) add({ key: "plan", ...me, what: `${days.length} days changed` });
  for (const k of keys) {
    if (days.length > MANY_DAYS && (k.startsWith("day:") || k === "plan")) continue;
    const what = describePart(k, a[k], b[k]) || "changed";
    add(k.startsWith("photo:") ? { key: k, ...me, what, ...(a[k] !== undefined ? { from: a[k] } : {}), ...(b[k] !== undefined ? { to: b[k] } : {}) } : { key: k, ...me, what });
  }
  return log.slice(-LOG_MAX);
}

/** Two sides' changes to a trip joined against what both had (shared/merge.ts), with the stamps joined newest-wins
 *  rather than compared (two people changing different days stamp different parts, but the stamps would clash), and both
 *  histories kept. */
export function mergeTrip(base: unknown, mine: unknown, theirs: unknown) {
  const strip = (t: unknown) => { if (!isObj(t)) return t; const { edits: _e, log: _l, ...rest } = t; return rest; };
  const m = merge3(strip(base), strip(mine), strip(theirs));
  const edits = joinEdits((mine as Trip)?.edits, (theirs as Trip)?.edits), log = joinLogs((mine as Trip)?.log, (theirs as Trip)?.log);
  if (isObj(m.value) && Object.keys(edits).length) (m.value as Trip).edits = edits;
  if (isObj(m.value) && log.length) (m.value as Trip).log = log;
  return m;
}

/** The part a clash's place in the trip (from merge3: "itinerary.days[2].items[0].time", "photoSpots.abc") is in. */
export function partOfPath(path: string, trip: Trip | null | undefined): string {
  const top = path.split(/[.[]/)[0];
  const day = /^itinerary\.days\[(\d+)\]/.exec(path);
  if (day) return dayKey(trip?.itinerary?.days || [], +day[1]);
  if (top === "itinerary" || top === "okRepeats") return "plan";
  if (top === "photoSpots") { const k = /^photoSpots\.([^.[]+)/.exec(path)?.[1]; return k ? `photo:${k}` : "photos"; }
  if (top === "photoFolders") return "photoFolders";
  for (const [k, f] of Object.entries(FIELDS)) if (f === top) return k;
  for (const [k, keys] of Object.entries(GROUPS)) if (keys.includes(top)) return k;
  return top || "trip";
}

/** Puts a part back as it was (`value` from partsOf; undefined: it wasn't there). False when that can't be done here (a
 *  day that isn't in the plan anymore, a whole plan). */
export function setPart(trip: Trip, key: string, value: unknown): boolean {
  if (key in FIELDS) { if (value === undefined) delete trip[FIELDS[key]]; else trip[FIELDS[key]] = value; return true; }
  if (key in GROUPS) { for (const f of GROUPS[key]) { const v = isObj(value) ? value[f] : undefined; if (v === undefined) delete trip[f]; else trip[f] = v; } return true; }
  if (key === "photoFolders") { if (Array.isArray(value)) trip.photoFolders = value.map((link) => ({ link })); else delete trip.photoFolders; return true; }
  if (key.startsWith("photo:")) {
    const k = key.slice(6), spots = { ...(isObj(trip.photoSpots) ? trip.photoSpots : {}) };
    if (value === undefined) delete spots[k]; else spots[k] = value;
    if (Object.keys(spots).length) trip.photoSpots = spots; else delete trip.photoSpots;
    return true;
  }
  if (key.startsWith("day:")) {
    const days = trip.itinerary?.days;
    if (!Array.isArray(days) || value === undefined) return false;
    const i = days.findIndex((_d: unknown, j: number) => dayKey(days, j) === key);
    if (i < 0) return false;
    trip.itinerary = { ...trip.itinerary, days: days.map((d: unknown, j: number) => (j === i ? value : d)) };
    return true;
  }
  if (key === "plan" && isObj(value) && isObj(trip.itinerary)) {
    const { okRepeats, ...plan } = value;
    trip.itinerary = { ...plan, days: trip.itinerary.days };
    if (okRepeats === undefined) delete trip.okRepeats; else trip.okRepeats = okRepeats;
    return true;
  }
  return false;
}

/** The history's entries about these parts. A day also gets the changes to many days at once (a re-planned stay), which
 *  are noted on the plan as a whole. */
export function changesTo(log: Change[], keys: string[]): Change[] {
  const day = keys.some((k) => k.startsWith("day:"));
  return log.filter((c) => keys.includes(c.key) || (day && c.key === "plan" && /\d+ days changed/.test(c.what)));
}

/** The stops the history says were taken off a day and that aren't on it now, newest first. */
export function removedStops(log: Change[], key: string, now: string[]): string[] {
  const on = new Set(now.map(short));
  const names = log.filter((c) => c.key === key).sort((a, b) => b.at - a.at)
    .flatMap((c) => c.what.split("; ").filter((w) => w.startsWith("removed ")))
    .flatMap((w) => w.slice(8).replace(/ and \d+ more$/, "").split(", "));
  return [...new Set(names)].filter((n) => n && !on.has(n));
}

// ---- In words ------------------------------------------------------------------------------------------------------------
const short = (s: unknown) => String(s ?? "").split(",")[0].trim();
const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);

/** A part's name: "Stays", "Day 3 · Kyoto", "Photo". */
export function partLabel(key: string, trip?: Trip | null): string {
  if (key.startsWith("day:")) {
    const days: any[] = trip?.itinerary?.days || [];
    const i = days.findIndex((_d, j) => dayKey(days, j) === key);
    const d = days[i];
    return i >= 0 ? `Day ${i + 1}${d?.city ? ` · ${short(d.city)}` : d?.title ? ` · ${d.title}` : ""}` : key.startsWith("day:#") ? "A day of the plan" : `The day of ${key.slice(4)}`;
  }
  if (key.startsWith("photo:")) return "Photo on the map";
  return ({ stays: "Stays", details: "Travelers & style", places: "Places", bookings: "Bookings", bookahead: "Book ahead", packing: "Packing list", ideas: "Ideas & notes", photoFolders: "Photo folders", plan: "The plan" } as Record<string, string>)[key] || key;
}

const FIELD_WORDS: Record<string, string> = {
  travelers: "travelers", people: "names", dailyBudget: "budget", currency: "currency", pace: "pace", fitness: "fitness", dayStart: "start of the day", breakfast: "breakfast",
  getAround: "getting around", interests: "interests", wishes: "what you want to see", notes: "notes for the plan", car: "car", lastRouteWhat: "route description",
  marks: "must-sees", who: "who wants what", how: "on the way or from a stay", customPlaces: "places picked on the map", kept: "must-sees kept", lists: "place lists", listSuggest: "suggested lists",
  packed: "ticked items", packingExtra: "own items",
};

/** What changed in a part, in a few words ("added Fushimi Inari; 2 times changed"); "" when there's nothing to add to
 *  its name. */
export function describePart(key: string, before: unknown, after: unknown): string {
  if (before === undefined && after !== undefined) return key.startsWith("photo:") ? photoWords(undefined, after) : key.startsWith("day:") ? "new day" : "added";
  if (after === undefined) return key.startsWith("photo:") ? "reset" : "removed";
  if (key.startsWith("photo:")) return photoWords(before, after);
  if (key.startsWith("day:")) return dayWords(before as any, after as any);
  if (key === "stays") return staysWords(before as any[], after as any[]);
  if (key === "bookings") return namedListWords(before as any[], after as any[], (b) => b?.name || "a booking");
  if (key === "places" && isObj(before) && isObj(after)) {
    const was = isObj(before.marks) ? before.marks : {}, now = isObj(after.marks) ? after.marks : {};
    const starred = Object.keys(now).filter((t) => now[t] === "must" && was[t] !== "must"), unstarred = Object.keys(was).filter((t) => was[t] === "must" && now[t] !== "must");
    const words = [starred.length ? `starred ${list(starred)}` : "", unstarred.length ? `unstarred ${list(unstarred)}` : ""].filter(Boolean);
    if (words.length) return words.join("; ");
  }
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k]));
    const words = keys.map((k) => (typeof after[k] === "number" && typeof before[k] === "number" ? `${FIELD_WORDS[k] || k} ${before[k]} → ${after[k]}` : FIELD_WORDS[k] || k));
    return words.length ? list(words, 4) : "";
  }
  if (typeof after === "string") return "edited";
  return "";
}

function photoWords(before: any, after: any) {
  if (after?.skip) return "marked can't place";
  if (!before || before.skip) return "placed";
  return "moved";
}

function dayWords(before: any, after: any) {
  const names = (d: any) => (Array.isArray(d?.items) ? d.items : []).map((x: any) => short(x?.place)).filter(Boolean) as string[];
  const was = names(before), now = names(after);
  const added = now.filter((n) => !was.includes(n)), removed = was.filter((n) => !now.includes(n));
  const words = [added.length ? `added ${list(added)}` : "", removed.length ? `removed ${list(removed)}` : ""].filter(Boolean);
  const kept = now.filter((n) => was.includes(n));
  const byName = (d: any) => new Map((d?.items || []).map((x: any) => [short(x?.place), x]));
  const b = byName(before), a = byName(after);
  const retimed = kept.filter((n) => (b.get(n) as any)?.time !== (a.get(n) as any)?.time).length;
  const edited = kept.filter((n) => !same(b.get(n), a.get(n))).length - retimed;
  if (retimed) words.push(`${retimed} time${retimed === 1 ? "" : "s"} changed`);
  if (!added.length && !removed.length && kept.length && kept.join() !== was.filter((n) => now.includes(n)).join()) words.push("reordered");
  if (edited > 0) words.push(`${edited} stop${edited === 1 ? "" : "s"} edited`);
  if (before?.title !== after?.title) words.push("new title");
  if ((before?.notes || "") !== (after?.notes || "")) words.push("notes");
  return words.join("; ") || "changed";
}

function staysWords(before: any[] = [], after: any[] = []) {
  const town = (s: any) => short(s?.city);
  const was = before.map(town).filter(Boolean), now = after.map(town).filter(Boolean);
  const added = now.filter((n) => !was.includes(n)), removed = was.filter((n) => !now.includes(n));
  const words = [added.length ? `added ${list(added)}` : "", removed.length ? `removed ${list(removed)}` : ""].filter(Boolean);
  const changed = after.filter((s) => { const b = before.find((x) => town(x) === town(s)); return b && !same(b, s); }).map(town);
  if (changed.length) words.push(`changed ${list(changed)}`);
  return words.join("; ") || "reordered";
}

function namedListWords(before: any[] = [], after: any[] = [], name: (x: any) => string) {
  const was = before.map(name), now = after.map(name);
  const added = now.filter((n) => !was.includes(n)), removed = was.filter((n) => !now.includes(n));
  const changed = after.filter((x) => { const b = before.find((y) => name(y) === name(x)); return b && !same(b, x); }).map(name);
  return [added.length ? `added ${list(added)}` : "", removed.length ? `removed ${list(removed)}` : "", changed.length ? `changed ${list(changed)}` : ""].filter(Boolean).join("; ") || "changed";
}
