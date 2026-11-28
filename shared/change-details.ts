// What exactly one change did, line by line, for the Changes window: "Budget 100 → 80", "+ 10:00 Fushimi Inari",
// "Kinkaku-ji: time 09:00 → 10:30". From what a part held before and after the change (kept by the computer that saved
// it: server/util/versions.ts keepPart). Plain data in, no page, so it can be tested.
import { FIELD_WORDS, dayKey, dayWords } from "./edits";
import { same } from "./merge";

/** One line of a change: `before` only: taken away; `after` only: added; both: changed from one to the other. */
export interface Line { what: string; before?: string; after?: string }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const NAME_KEYS = ["place", "name", "city", "title", "what"];
/** What a thing in a list is called (a stop's place, a stay's town, a booking's name). */
const nameOf = (x: unknown) => (isObj(x) ? String(NAME_KEYS.map((k) => x[k]).find((v) => typeof v === "string" && v) ?? "") : "");
/** Words for a field ("dailyBudget" → "budget"; a key that is data, "stop:2027-04-01|Gion", its last part). */
const WORDS: Record<string, string> = { ...FIELD_WORDS, items: "stops", estimatedCost: "cost", dayTrips: "day trips", nights: "nights", hotel: "hotel", travel: "getting there", start: "from",
  time: "time", description: "description", transport: "getting there", cost: "cost", kind: "kind", notes: "notes", title: "title", city: "town", date: "date", durationMinutes: "length (min)",
  summary: "overview", tips: "tips", totalEstimatedCost: "total cost", budgetPer: "budget is per", holidaysAndEvents: "holidays & events", unused: "left out", ideas: "ideas & notes" };
const word = (k: string) => WORDS[k] ?? (k.includes("|") ? k.split("|").pop()! : k);

/** A value in words ("" for nothing). */
export function valueText(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map((x) => nameOf(x) || valueText(x)).filter(Boolean).join(", ");
  return Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== "" && typeof x !== "object").map(([k, x]) => `${word(k)}: ${valueText(x)}`).join(", ");
}

/** A thing of a list in a few words: a stop with its time, anything else by its name (or what it holds). */
const itemText = (x: unknown) => (isObj(x) && nameOf(x) ? `${typeof x.time === "string" && x.time ? `${x.time} ` : ""}${nameOf(x)}${typeof x.nights === "number" ? ` (${x.nights} night${x.nights === 1 ? "" : "s"})` : ""}` : valueText(x));

const MAX_DEPTH = 2;

function walk(label: string, b: unknown, a: unknown, out: Line[], depth: number) {
  if (same(b ?? null, a ?? null)) return;
  const lists = (Array.isArray(b) || b == null) && (Array.isArray(a) || a == null) && (Array.isArray(b) || Array.isArray(a));
  if (lists) {
    const was = (b as unknown[]) || [], now = (a as unknown[]) || [];
    const top = !label || label === "stops";
    const named = [...was, ...now].every((x) => nameOf(x));
    const key = (x: unknown) => (named ? nameOf(x) : JSON.stringify(x));
    // (The same name twice in a list: matched in order.)
    const left = [...was], added: unknown[] = [], pairs: [unknown, unknown][] = [];
    for (const x of now) {
      const i = left.findIndex((y) => key(y) === key(x));
      if (i < 0) added.push(x); else pairs.push([left.splice(i, 1)[0], x]);
    }
    for (const x of added) out.push({ what: top ? "added" : `${label}: added`, after: itemText(x) });
    for (const x of left) out.push({ what: top ? "removed" : `${label}: removed`, before: itemText(x) });
    for (const [x, y] of pairs) {
      if (same(x, y)) continue;
      if (depth < MAX_DEPTH && isObj(x) && isObj(y)) for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(`${nameOf(y)}: ${word(k)}`, x[k], y[k], out, depth + 1);
      else out.push({ what: nameOf(y) || label, before: valueText(x), after: valueText(y) });
    }
    const order = (l: unknown[]) => l.filter((x) => now.some((y) => key(y) === key(x)) && was.some((y) => key(y) === key(x))).map((x) => (named ? nameOf(x) : valueText(x)));
    if (order(was).join("\n") !== order(now).join("\n")) out.push({ what: top ? "order" : `${label}: order`, before: order(was).join(" → "), after: order(now).join(" → ") });
    return;
  }
  if ((isObj(b) || b == null) && (isObj(a) || a == null) && (isObj(b) || isObj(a)) && depth < MAX_DEPTH) {
    const x = (b as Record<string, unknown>) || {}, y = (a as Record<string, unknown>) || {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(label ? `${label}: ${word(k)}` : word(k), x[k], y[k], out, depth + 1);
    return;
  }
  const before = valueText(b), after = valueText(a);
  if (before !== after) out.push({ what: label, ...(before ? { before } : {}), ...(after ? { after } : {}) });
}

/** A part's change in lines. `whole`: the values are whole plans (a change to many days at once): a line per day. */
export function changeLines(key: string, before: unknown, after: unknown, whole = false): Line[] {
  const out: Line[] = [];
  if (key.startsWith("photo:")) return out; // "moved", "placed": the words say it all
  if (whole) {
    const was: any[] = isObj(before) && Array.isArray(before.days) ? before.days : [], now: any[] = isObj(after) && Array.isArray(after.days) ? after.days : [];
    const old = new Map(was.map((d, i) => [dayKey(was, i), d]));
    now.forEach((d, i) => {
      const k = dayKey(now, i), b = old.get(k);
      old.delete(k);
      if (!b) out.push({ what: `day ${i + 1}${d?.date ? ` · ${d.date}` : ""}`, after: `new: ${valueText(d?.items) || "no stops"}` });
      else if (!same(b, d)) out.push({ what: `day ${i + 1}${d?.date ? ` · ${d.date}` : ""}`, after: dayWords(b, d) });
    });
    for (const d of old.values()) out.push({ what: `the day of ${d?.date || "?"}`, before: valueText(d?.items) || "no stops" });
    return out;
  }
  // Expenses are kept by an id nobody knows them by: as a list, by what they were for.
  const list = (v: unknown) => (key === "expenses" && isObj(v) ? Object.values(v) : v);
  // (A part that is a list or a text has no field names to go by: lines without a label.)
  walk("", list(before), list(after), out, 0);
  return out;
}

/** A piece of text that stayed (0), went (-1) or came (1). */
export interface Piece { op: -1 | 0 | 1; text: string }

/** Two texts compared word by word (longer texts: so the changed words stand out instead of two whole paragraphs).
 *  Null when they're too long to compare this way, or share next to nothing. */
export function wordDiff(a: string, b: string): Piece[] | null {
  const x = a.match(/\s+|[^\s]+/g) || [], y = b.match(/\s+|[^\s]+/g) || [];
  if (x.length * y.length > 250_000) return null;
  // Longest common run of tokens, by the usual table.
  const t = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const kept = x.filter((w) => w.trim()).length ? t[0][0] / Math.max(x.length, y.length) : 0;
  if (kept < 0.3) return null;
  const out: Piece[] = [];
  const push = (op: Piece["op"], text: string) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += text; else out.push({ op, text }); };
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { push(0, x[i]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) push(-1, x[i++]);
    else push(1, y[j++]);
  }
  while (i < x.length) push(-1, x[i++]);
  while (j < y.length) push(1, y[j++]);
  return out;
}
