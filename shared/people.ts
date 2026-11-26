// Who does each stop, by name ("who": ["Me", "Anna"]), on a trip whose travelers are named (Travelers & style →
// Names). Splits and meet-ups follow from it: people are apart while their stops differ, and together again at a stop
// they share. (Plans from before use group labels instead, see web/src/trip/split-tree.ts.)

/** The mark between the names of a company ("Me + Anna"): never part of a name. */
export const JOIN = " + ";

/** Names as typed or as a model wrote them: trimmed, no "+" or commas, each once, at most 30. */
export function cleanNames(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [];
  const out: string[] = [];
  for (const x of list) {
    const n = typeof x === "string" ? x.replace(/[+,;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) : "";
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.slice(0, 30);
}

/** Who does a stop while the group is apart, in the travelers' order; none when everyone does (or nobody's said).
 *  Names not among the travelers are kept as written. */
export function company(who: unknown, names: string[], travelers = 0): string[] {
  const listed = cleanNames(who);
  if (!listed.length) return [];
  const known = listed.map((n) => names.find((x) => x.toLowerCase() === n.toLowerCase()) || n);
  const rank = (n: string) => { const i = names.indexOf(n); return i < 0 ? names.length : i; };
  const sorted = [...new Set(known)].sort((a, b) => rank(a) - rank(b));
  const all = Math.max(travelers, names.length);
  return all > 1 && sorted.length >= all ? [] : sorted;
}

interface Stop { time: string; who?: string[] }

/** A split part of a day: a column for each company that's apart, its stops in time order. */
export interface Fork { cols: { who: string[]; items: number[] }[]; /** Others still doing something from before. */ meanwhile: { who: string[]; item: number }[] }
export type Section = { item: number } | { fork: Fork };

const minutes = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };

/** The stops in time order (a stop without a time stays after the one before it); equal times keep their order. */
export function byTime<T extends { time: string }>(items: T[]): T[] {
  let last = -1;
  return items.map((x, i) => ({ x, i, at: (last = minutes(x.time) ?? last) })).sort((a, b) => a.at - b.at || a.i - b.i).map((e) => e.x);
}

const key = (who: string[]) => who.join(JOIN);
const shares = (a: string[], b: string[]) => a.some((n) => b.includes(n));

/** A day (its stops in time order) as the plan shows it: stops everyone does on their own, and between them the splits,
 *  a column for each company. When people regroup (two columns meet, or one splits further) a new split starts, and
 *  whoever isn't part of it is noted as still at what they were doing. `whoOf`: a stop's company (none: everyone). */
export function sections<T extends Stop>(items: T[], whoOf: (x: T) => string[]): Section[] {
  const out: Section[] = [];
  let fork: Fork | null = null;
  /** What each person apart is at (their last stop). */
  const at = new Map<string, number>();
  const close = () => { if (fork) out.push({ fork }); fork = null; };
  items.forEach((x, i) => {
    const who = whoOf(x);
    if (!who.length) { close(); at.clear(); out.push({ item: i }); return; }
    let col = fork?.cols.find((c) => key(c.who) === key(who));
    // Regrouping: someone here is in another column of this split.
    if (fork && !col && fork.cols.some((c) => shares(c.who, who))) close();
    if (!fork) fork = { cols: [], meanwhile: [] };
    if (!col) { col = fork.cols.find((c) => key(c.who) === key(who)); if (!col) fork.cols.push((col = { who, items: [] })); }
    col.items.push(i);
    for (const n of who) at.set(n, i);
    // Everyone else apart who isn't in this split: still at their last stop.
    const here = fork.cols.flatMap((c) => c.who);
    const rest = new Map<number, string[]>();
    for (const [n, k] of at) if (!here.includes(n)) rest.set(k, [...(rest.get(k) || []), n]);
    fork.meanwhile = [...rest].map(([item, w]) => ({ item, who: w }));
  });
  close();
  return out;
}
