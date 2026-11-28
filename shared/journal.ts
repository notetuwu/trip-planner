// The trip's journal: a few loose lines per day on what they really did (written in the phone file during the trip, or
// in the app), and the "actual" day a model works out from them next to the planned one: the stops in order with rough
// times, how they got around, and what was spent by whom. The plan itself stays as it was. No page or server code here,
// so it can be tested.
import type { Day, ItineraryItem } from "./types";
import type { ExpenseKind } from "./expenses";

export interface JournalEntry {
  text: string;
  /** When it was last written (ms). */
  at: number;
  /** The plan's stops of that day ticked as done in the phone file, by name. */
  done?: string[];
}
/** By date (YYYY-MM-DD). */
export type Journal = Record<string, JournalEntry>;

/** An expense the journal mentions, for them to add to Costs (or not). */
export interface FoundExpense { what: string; amount: number; currency: string; paidBy?: string; split?: string[]; kind?: ExpenseKind }

/** A day as it really went. */
export interface ActualDay extends Day {
  /** The journal entry it was worked out from (its `at`): the entry changed since when they differ. */
  from: number;
  expenses?: FoundExpense[];
  /** What the entry left open ("what the boat tickets cost"). */
  unclear?: string[];
  /** The expenses were added to Costs. */
  added?: boolean;
  /** Which of its stops (by index) are the plan's own, kept as planned because the entry didn't say otherwise. */
  kept?: number[];
}
export type Actual = Record<string, ActualDay>;

/** Two journals as one: of each day, the entry written last. */
export function mergeJournal(mine: Journal | undefined, theirs: unknown): { journal: Journal; taken: number } {
  const out: Journal = { ...(mine || {}) };
  let taken = 0;
  if (theirs && typeof theirs === "object") {
    for (const [date, e] of Object.entries(theirs as Record<string, any>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !e || typeof e.text !== "string") continue;
      const entry: JournalEntry = { text: e.text.slice(0, 20_000), at: Number(e.at) || 0, ...(Array.isArray(e.done) ? { done: e.done.filter((x: unknown) => typeof x === "string").slice(0, 60) } : {}) };
      const have = out[date];
      if (have && (have.at >= entry.at || (have.text === entry.text && String(have.done) === String(entry.done)))) continue;
      if (!entry.text.trim() && !entry.done?.length && !have) continue;
      out[date] = entry; taken++;
    }
  }
  return { journal: out, taken };
}

const KINDS: NonNullable<ItineraryItem["kind"]>[] = ["sight", "meal", "activity", "transfer", "other"];
const SPENT: ExpenseKind[] = ["food", "sights", "transport", "stay", "shopping", "other"];
const hhmm = (t: unknown) => { const m = /^(\d{1,2})[:.](\d{2})/.exec(String(t ?? "").trim()); return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A model's answer as an actual day: only what the app's days hold, whatever came back. Null when it isn't one. */
export function cleanActual(raw: unknown, o: { date: string; city: string; people: string[]; currency: string; from: number; planned?: ItineraryItem[] }): ActualDay | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (!Array.isArray(r.items)) return null;
  const person = (v: unknown) => o.people.find((p) => p.toLowerCase() === String(v ?? "").trim().toLowerCase());
  // {"keep": 2}: the plan's second stop as it was planned (a time of its own when the answer gives one).
  const plannedAt = (x: any) => (x && Number.isInteger(x.keep) ? o.planned?.[x.keep - 1] : undefined);
  const kept: number[] = [];
  const items: ItineraryItem[] = r.items.filter((x: any) => x && (plannedAt(x) || str(x.place, 200))).slice(0, 40).map((x: any, i: number) => {
    const was = plannedAt(x);
    if (was) { kept.push(i); return { ...was, ...(hhmm(x.time) ? { time: hhmm(x.time) } : {}) }; }
    const cost = Number(x.cost), who = Array.isArray(x.who) ? x.who.map(person).filter((p: string | undefined): p is string => !!p) : [];
    return {
      time: hhmm(x.time), place: str(x.place, 200), description: str(x.description, 1200),
      kind: KINDS.includes(x.kind) ? x.kind : "other",
      ...(str(x.transport, 300) ? { transport: str(x.transport, 300) } : {}),
      ...(Number.isFinite(cost) && cost > 0 ? { cost: Math.round(cost * 100) / 100 } : {}),
      // (Everyone: no names, as in the plan.)
      ...(who.length && who.length < o.people.length ? { who } : {}),
    } as ItineraryItem;
  });
  const expenses: FoundExpense[] = (Array.isArray(r.expenses) ? r.expenses : []).filter((e: any) => e && Number(e.amount) > 0 && Number.isFinite(Number(e.amount)) && str(e.what, 120)).slice(0, 40).map((e: any) => {
    const split = Array.isArray(e.for) ? [...new Set(e.for.map(person).filter((p: string | undefined): p is string => !!p))] as string[] : [];
    return {
      what: str(e.what, 120), amount: Math.round(Number(e.amount) * 100) / 100,
      currency: /^[A-Za-z]{3}$/.test(String(e.currency || "")) ? String(e.currency).toUpperCase() : o.currency,
      ...(person(e.paidBy) ? { paidBy: person(e.paidBy) } : {}),
      ...(split.length && split.length < o.people.length ? { split } : {}),
      kind: SPENT.includes(e.kind) ? e.kind : "other",
    };
  });
  const unclear = (Array.isArray(r.unclear) ? r.unclear : []).map((u: unknown) => str(u, 200)).filter(Boolean).slice(0, 10);
  return {
    date: o.date, city: str(r.city, 120) || o.city, title: str(r.title, 160) || o.city, ...(str(r.notes, 1500) ? { notes: str(r.notes, 1500) } : {}),
    estimatedCost: items.reduce((n, x) => n + (Number(x.cost) || 0), 0), items, from: o.from,
    ...(expenses.length ? { expenses } : {}), ...(unclear.length ? { unclear } : {}), ...(kept.length ? { kept } : {}),
  };
}

/** The trip as it really went: each day's actual version where there is one, else the planned day. */
export function actualDays<T extends { date: string }>(days: T[], actual: Actual | undefined): (T | ActualDay)[] {
  return days.map((d) => actual?.[d.date] || d);
}
