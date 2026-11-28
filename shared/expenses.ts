// What a trip really cost: expenses as they were paid (who paid, for whom, in which currency), what each traveler is owed
// or owes, and the fewest payments that settle it. Kept in the trip by id (state.expenses), so two people adding or
// changing different expenses at once join without a clash (shared/merge.ts). No page or server code here, so it can
// be tested.

export type ExpenseKind = "food" | "sights" | "transport" | "stay" | "shopping" | "other" | "settle";

export interface Expense {
  what: string;
  /** As paid, in `currency`. */
  amount: number;
  currency: string;
  /** What 1 of `currency` was in `rateTo` when it was entered (or as they typed it: their card's own rate), so totals
   *  don't move with the exchange rates afterwards. Unset, or for another trip currency: today's rate. */
  rate?: number;
  rateTo?: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Who paid it, by name (unset: nobody said, as on a trip with one traveler). */
  paidBy?: string;
  /** Each of those it was for paid their own share (tickets bought one by one): spent, but nobody owes anybody. */
  each?: boolean;
  /** Who it was for, by name; unset or empty: everyone. */
  split?: string[];
  /** Of those it was for, the ones whose share the payer covers: they owe nothing for it (the others owe their share). */
  covered?: string[];
  /** Of those it was for, the ones who paid their own share themselves (their own ticket): they owe nothing, and the payer
   *  only paid the rest. */
  own?: string[];
  /** Of those it was for, the ones who owed their share and already gave it to the payer (in cash, say): even for it. */
  back?: string[];
  /** What it was; "settle" is one traveler paying another back (not spending). */
  kind?: ExpenseKind;
  /** When it was entered (ms), for the order of a day's expenses. */
  at?: number;
  /** What some of those it was for had, set by hand (in `currency`): the rest of the amount is split evenly among the
   *  others. Unset: everyone's part is the same. */
  shares?: Record<string, number>;
  /** What in the trip it paid for, when entered next to it in the Costs window: "stop:<date>|<place>",
   *  "stay:<town>|<arrival>" or "booking:<name>|<date>". (Renamed or moved since: it stays an expense of its own.) */
  link?: string;
}

export type Expenses = Record<string, Expense>;

export const KINDS: [ExpenseKind, string][] = [["food", "Food & drink"], ["sights", "Sights & activities"], ["transport", "Getting around"], ["stay", "Accommodation"], ["shopping", "Shopping"], ["other", "Other"]];

/** A new expense's id: unique enough across travelers adding at the same time. */
export const expenseId = (now = Date.now()) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Decimals a currency is counted in (yen and won have none). */
export const decimals = (cur: string) => (["JPY", "KRW", "VND", "IDR", "HUF", "ISK", "CLP", "TWD"].includes(cur) ? 0 : 2);
const round = (n: number, cur: string) => { const f = 10 ** decimals(cur); return Math.round(n * f) / f; };

/** What an expense comes to in the trip's currency: as paid, by its own rate, or by today's (fx: per 1 EUR, as from
 *  /api/fx); null when there's no rate for it. */
export function inTrip(e: Expense, cur: string, fx: Record<string, number>): number | null {
  const amount = Number(e.amount) || 0;
  if (!e.currency || e.currency === cur) return amount;
  if (e.rate && e.rateTo === cur) return amount * e.rate;
  const a = e.currency === "EUR" ? 1 : fx[e.currency], b = cur === "EUR" ? 1 : fx[cur];
  return a && b ? (amount / a) * b : null;
}

/** Today's rate of one currency in another (fx per 1 EUR); 0 when unknown. */
export function rateOf(from: string, to: string, fx: Record<string, number>): number {
  if (from === to) return 1;
  const a = from === "EUR" ? 1 : fx[from], b = to === "EUR" ? 1 : fx[to];
  return a && b ? b / a : 0;
}

/** Who an expense was for: the names it was split among that are travelers, or everyone. */
export function sharedBy(e: Expense, everyone: string[]): string[] {
  const named = (e.split || []).filter((n) => everyone.includes(n));
  return named.length ? named : everyone;
}

/** Each traveler's balance in the trip's currency: what they paid minus their share. Above 0 they get money back, below
 *  0 they owe. Names that aren't travelers anymore (someone renamed) are kept, so nothing goes missing. */
export function balances(list: Expense[], everyone: string[], cur: string, fx: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(everyone.map((n) => [n, 0]));
  for (const e of list) {
    const v = inTrip(e, cur, fx);
    if (v == null || e.each || !e.paidBy) continue;
    const parts = costShares(e, v, everyone);
    if (!Object.keys(parts).length) continue;
    // Those who paid their own share, or already paid the payer back, are even for it; the payer is owed the rest.
    const own = new Set([...ownBy(e, everyone), ...backBy(e, everyone)]), ownSum = [...own].reduce((t, n) => t + (parts[n] || 0), 0);
    out[e.paidBy] = (out[e.paidBy] || 0) + v - ownSum;
    for (const [n, x] of Object.entries(parts)) if (!own.has(n)) out[n] = (out[n] || 0) - x;
  }
  return out;
}

/** Who it was for, and whose share the one who paid took over ("I'll get Anna's"): those owe nothing for it. */
export function coveredBy(e: Expense, everyone: string[]): string[] {
  const who = e.split?.length ? e.split : everyone;
  const own = [...(e.own || []), ...(e.back || [])];
  return e.paidBy && !e.each ? (e.covered || []).filter((n) => n !== e.paidBy && who.includes(n) && !own.includes(n)) : [];
}

/** Who it was for and paid their own share themselves (everyone, when each paid their own). */
export function ownBy(e: Expense, everyone: string[]): string[] {
  const who = e.split?.length ? e.split : everyone;
  return e.each ? who : e.paidBy ? (e.own || []).filter((n) => n !== e.paidBy && who.includes(n)) : [];
}

/** Who it was for and already paid the payer back their share. */
export function backBy(e: Expense, everyone: string[]): string[] {
  const who = e.split?.length ? e.split : everyone, own = e.own || [];
  return e.paidBy && !e.each ? (e.back || []).filter((n) => n !== e.paidBy && who.includes(n) && !own.includes(n)) : [];
}

/** How a person stands in an expense: paid it, owes the payer their share, covered by the payer, paid their own, or not in it. */
export type Stand = "payer" | "owes" | "covered" | "own" | "back" | "out";
export function standOf(e: Expense, n: string, everyone: string[]): Stand {
  const who = e.split?.length ? e.split : everyone;
  if (!e.each && n === e.paidBy) return "payer";
  if (!who.includes(n)) return "out";
  return ownBy(e, everyone).includes(n) ? "own" : backBy(e, everyone).includes(n) ? "back" : coveredBy(e, everyone).includes(n) ? "covered" : "owes";
}

/** What each person's part of an expense comes to (v: the expense in the trip's currency): their part (partsOf: even,
 *  or as set by hand; parts that don't add up to the amount are scaled to it), and the parts of those the payer covered
 *  on the payer. Names it was split among that aren't travelers anymore
 *  (someone renamed) keep theirs, so nothing goes missing. */
export function costShares(e: Expense, v: number, everyone: string[]): Record<string, number> {
  const who = e.split?.length ? e.split : everyone, out: Record<string, number> = {};
  if (!who.length) return out;
  const covered = new Set(coveredBy(e, everyone)), parts = partsOf(e, everyone);
  const total = Object.values(parts).reduce((t, x) => t + x, 0);
  for (const n of who) {
    const to = covered.has(n) ? e.paidBy! : n;
    out[to] = (out[to] || 0) + (total > 0 ? (parts[n] / total) * v : v / who.length);
    if (covered.has(n)) out[n] ??= 0;
  }
  return out;
}

/** Each one's part of an expense in its own currency: what was set for them by hand ("shares"), and what's left of the
 *  amount split evenly among the others it was for. */
export function partsOf(e: Pick<Expense, "amount" | "split" | "shares">, everyone: string[]): Record<string, number> {
  const who = e.split?.length ? e.split : everyone, out: Record<string, number> = {};
  const set = new Map(Object.entries(e.shares || {}).filter(([n, v]) => who.includes(n) && Number.isFinite(v) && v >= 0));
  const fixed = [...set.values()].reduce((t, v) => t + v, 0), free = who.filter((n) => !set.has(n));
  for (const n of who) out[n] = set.has(n) ? set.get(n)! : Math.max(0, (Number(e.amount) || 0) - fixed) / free.length;
  return out;
}

/** What the parts leave of the amount (below 0: they come to more), in its currency; 0 when they add up. */
export function unassigned(e: Pick<Expense, "amount" | "split" | "shares" | "currency">, everyone: string[]) {
  const left = (Number(e.amount) || 0) - Object.values(partsOf(e, everyone)).reduce((t, v) => t + v, 0);
  return Math.abs(left) < 0.5 / 10 ** decimals(e.currency || "EUR") ? 0 : left;
}

export interface Payment { from: string; to: string; amount: number }

/** The fewest payments that even the balances out: whoever owes most pays whoever gets most back, and so on. Amounts
 *  below the currency's smallest unit are left out. */
export function settleUp(bal: Record<string, number>, cur: string): Payment[] {
  const tiny = 0.5 / 10 ** decimals(cur);
  const owe = Object.entries(bal).filter(([, v]) => v < -tiny).map(([n, v]) => ({ n, v: -v })).sort((a, b) => b.v - a.v);
  const get = Object.entries(bal).filter(([, v]) => v > tiny).map(([n, v]) => ({ n, v })).sort((a, b) => b.v - a.v);
  const out: Payment[] = [];
  let i = 0, j = 0;
  while (i < owe.length && j < get.length) {
    const pay = Math.min(owe[i].v, get[j].v), amount = round(pay, cur);
    if (amount > tiny) out.push({ from: owe[i].n, to: get[j].n, amount });
    owe[i].v -= pay; get[j].v -= pay;
    if (owe[i].v <= tiny) i++;
    if (get[j].v <= tiny) j++;
  }
  return out;
}

/** What was spent (paying each other back left out), in the trip's currency: in all, per day, per kind, and what each
 *  traveler's share came to. `unrated`: expenses without a rate, not counted. */
export function spending(list: Expense[], everyone: string[], cur: string, fx: Record<string, number>) {
  const byDay: Record<string, number> = {}, byKind: Record<string, number> = {}, share: Record<string, number> = {};
  let total = 0, unrated = 0;
  for (const e of list) {
    if (e.kind === "settle") continue;
    const v = inTrip(e, cur, fx);
    if (v == null) { unrated++; continue; }
    total += v;
    byDay[e.date] = (byDay[e.date] || 0) + v;
    byKind[e.kind || "other"] = (byKind[e.kind || "other"] || 0) + v;
    for (const [n, x] of Object.entries(costShares(e, v, everyone))) share[n] = (share[n] || 0) + x;
  }
  return { total, byDay, byKind, share, unrated };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** The phone's expenses brought back into the app's: against what the phone file started from (`base`), an expense the
 *  phone added, changed or removed takes the phone's version; one only the app changed since keeps the app's; one both
 *  changed differently keeps the app's (counted as a clash). Without a base (an older file): only new ones are added. */
export function mergeFromPhone(base: Expenses | undefined, app: Expenses | undefined, phone: unknown) {
  const b = base || {}, a = app || {}, out: Expenses = {};
  const p: Expenses = {};
  if (phone && typeof phone === "object" && !Array.isArray(phone)) for (const [id, e] of Object.entries(phone)) { const x = cleanExpense(e); if (x) p[id] = x; }
  let added = 0, changed = 0, removed = 0, clashes = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(p), ...Object.keys(b)])) {
    const was = b[id], mine = a[id], theirs = p[id];
    if (sameJson(theirs, was)) { if (mine) out[id] = mine; continue; } // the phone left it alone
    if (!base && mine) { out[id] = mine; continue; }                // older file: never overwrite
    if (sameJson(mine, was)) {                                       // only the phone changed it
      if (theirs) { out[id] = theirs; if (was) changed++; else added++; } else removed++;
      continue;
    }
    if (sameJson(mine, theirs)) { if (mine) out[id] = mine; continue; } // both the same
    clashes++;
    if (mine) out[id] = mine; else if (theirs) out[id] = theirs;
  }
  return { expenses: out, added, changed, removed, clashes };
}

/** Expenses from another copy (the phone file) added to these: ones already here are kept as they are. */
export function joinExpenses(mine: Expenses | undefined, more: unknown): { expenses: Expenses; added: number } {
  const out: Expenses = { ...(mine || {}) };
  let added = 0;
  if (more && typeof more === "object" && !Array.isArray(more)) {
    for (const [id, e] of Object.entries(more as Record<string, unknown>)) {
      const x = cleanExpense(e);
      if (x && !out[id]) { out[id] = x; added++; }
    }
  }
  return { expenses: out, added };
}

/** An expense as it may be kept, from whatever was read (a file someone sent); null when it isn't one. */
export function cleanExpense(v: unknown): Expense | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const amount = Number(e.amount), what = String(e.what ?? "").trim().slice(0, 120), date = String(e.date ?? "");
  if (!isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const cur = /^[A-Z]{3}$/.test(String(e.currency)) ? String(e.currency) : "";
  if (!cur) return null;
  const kind = [...KINDS.map(([k]) => k), "settle"].includes(String(e.kind)) ? (e.kind as ExpenseKind) : undefined;
  const names = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string" && !!n.trim()).map((n) => n.trim().slice(0, 30)).slice(0, 30) : []);
  const split = names(e.split), covered = names(e.covered), own = names(e.own), back = names(e.back);
  const shares = e.shares && typeof e.shares === "object" && !Array.isArray(e.shares)
    ? Object.fromEntries(Object.entries(e.shares as Record<string, unknown>).map(([n, v]) => [n.trim().slice(0, 30), Number(v)] as const).filter(([n, v]) => n && Number.isFinite(v) && v >= 0).slice(0, 30)) : {};
  return {
    what: what || "Expense", amount, currency: cur, date,
    ...(Number(e.rate) > 0 && /^[A-Z]{3}$/.test(String(e.rateTo)) ? { rate: Number(e.rate), rateTo: String(e.rateTo) } : {}),
    ...(typeof e.paidBy === "string" && e.paidBy.trim() ? { paidBy: e.paidBy.trim().slice(0, 30) } : {}),
    ...(e.each === true ? { each: true } : {}),
    ...(split.length ? { split } : {}),
    ...(covered.length ? { covered } : {}),
    ...(own.length ? { own } : {}),
    ...(back.length ? { back } : {}),
    ...(Object.keys(shares).length ? { shares } : {}),
    ...(kind ? { kind } : {}),
    ...(Number(e.at) > 0 ? { at: Number(e.at) } : {}),
    ...(typeof e.link === "string" && /^(stop|stay|booking):/.test(e.link) ? { link: e.link.slice(0, 300) } : {}),
  };
}
