// Joining two people's changes to the same trip: what both had last (the base), this side's version and the other side's.
// A part only one of them changed takes that change; a part both changed the same way is kept; only a part both changed
// differently is a clash. Objects are joined key by key; lists of the same length item by item (days, stays, a day's
// stops); a list both added to at the end (the chat) gets both additions. No page or server code here, so it can be tested.

export interface Merged { value: unknown; clashes: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Same content (keys in any order). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
  }
  return false;
}

const startsWith = (list: unknown[], base: unknown[]) => list.length >= base.length && base.every((x, i) => same(x, list[i]));

export function merge3(base: unknown, mine: unknown, theirs: unknown): Merged {
  const clashes: string[] = [];
  const walk = (b: unknown, a: unknown, t: unknown, at: string): unknown => {
    if (same(a, t)) return a;
    if (same(a, b)) return t;
    if (same(t, b)) return a;
    // Both changed it, differently.
    if (isObj(a) && isObj(t) && (isObj(b) || b === undefined)) {
      const bo = (b || {}) as Record<string, unknown>, out: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(t), ...Object.keys(bo)])) {
        const v = walk(bo[k], a[k], t[k], at ? `${at}.${k}` : k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(a) && Array.isArray(t) && Array.isArray(b)) {
      if (a.length === b.length && t.length === b.length) return a.map((x, i) => walk(b[i], x, t[i], `${at}[${i}]`));
      // Both added at the end (and changed nothing before): both additions, this side's first.
      if (startsWith(a, b) && startsWith(t, b)) return [...b, ...a.slice(b.length), ...t.slice(b.length)];
    }
    clashes.push(at || "(the whole trip)");
    return a;
  };
  return { value: walk(base, mine, theirs, ""), clashes };
}
