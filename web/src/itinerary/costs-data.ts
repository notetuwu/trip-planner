// What the Costs window's tabs share: the expenses as a list, exchange rates, who travels, and changing an expense
// (with Undo inside the window, since the page's toast can't be clicked behind it).
import { type Expense, type ExpenseKind, type Stand, decimals, expenseId, inTrip, rateOf } from "../../../shared/expenses";
import type { ItineraryItem } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { CURRENCIES, currencySymbol, money, todayIso } from "../core/format";
import { icon } from "../core/icons";
import { togglePopup } from "../core/menu";
import { save, state } from "../core/state";
import { prefs } from "../core/prefs";
import { isReadOnly } from "../saves/read-only";

export type Row = Expense & { id: string };

/** Exchange rates per 1 EUR (from /api/fx, once a session). */
export let fx: Record<string, number> = { EUR: 1 };
let fxAsked: Promise<boolean> | null = null;
export const loadFx = () => (fxAsked ??= api<Record<string, number>>("/api/fx").then((r) => { fx = { EUR: 1, ...r }; fxReady = true; return true; }).catch(() => { fxAsked = null; return false; }));
/** An amount in the trip's currency (or `from`), shown in the currency picked under "Show prices in" (converted at the
 *  day's rate; as it is while there's no rate). */
export function shown(n: number | undefined, from: string = state.currency, whole = false): string {
  if (n == null || isNaN(n)) return "";
  const to = displayCurrency();
  if (to === from) return money(n, from, whole);
  const r = rateOf(from, to, fx);
  return r ? money(n * r, to, whole) : money(n, from, whole);
}

// What prices are shown in is kept on this computer, per trip (never in the trip itself, so it isn't synced): the
// trip's own choice when one was made with the picker, else the default from Settings → General.
const SHOW_KEY = "trip-planner-show-currency";
const tripKey = () => state.sync?.id || state.saveName || "(unsaved)";
const picks = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(SHOW_KEY) || "{}"); } catch { return {}; } };
/** "" (the trip's currency), "local", or a currency, as the default says it. */
const resolve = (v: string) => (v === "local" ? state.itinerary?.localCurrency || state.currency : v || state.currency);
/** The currency prices are shown in now. */
export const displayCurrency = (): string => { const p = picks()[tripKey()]; return resolve(p ?? prefs.app.displayCurrency); };

/** "Show prices in": a button with the currency shown now; `attr` tells the pickers apart. */
export function displayPicker(attr: string) {
  const trip = state.currency, local = state.itinerary?.localCurrency, now = displayCurrency();
  const name = now === trip ? `${now} · trip` : now === local ? `${now} · local` : now;
  return `<button type="button" class="show-cur" ${attr} aria-haspopup="menu" aria-expanded="false" aria-label="Show prices in: ${esc(name)}" title="Show prices in another currency (converted at the day's exchange rate; you still enter them in ${esc(trip)})">${icon("coins")}<span>${esc(name)}</span>${icon("chevronDown")}</button>`;
}

/** Opens its list at the button: the trip's currency, the local one, then the rest. (The app's own list: not every
 *  browser can style its own.) */
export function pickDisplayCurrency(anchor: HTMLElement, then: () => void) {
  const trip = state.currency, local = state.itinerary?.localCurrency, now = displayCurrency();
  const opt = (c: string, note = "") => {
    const sign = currencySymbol(c);
    return `<button type="button" role="menuitemradio" aria-checked="${c === now}" data-cur="${esc(c)}"><span>${esc(c)}${sign === c ? "" : ` <i>${esc(sign)}</i>`}${note ? ` · ${note}` : ""}</span></button>`;
  };
  togglePopup(anchor, {
    className: "cur-pop", end: true,
    html: `${opt(trip, "trip")}${local && local !== trip ? opt(local, "local") : ""}
      <div class="cur-more" role="group" aria-label="Other currencies"><h6>Other currencies</h6>${CURRENCIES.filter((c) => c !== trip && c !== local).map((c) => opt(c)).join("")}</div>`,
    pick: (b) => setDisplayCurrency(b.dataset.cur!, then),
  });
}

/** Sets what prices are shown in (the trip's currency: none), with the rates fetched first. */
async function setDisplayCurrency(c: string, then: () => void) {
  const all = picks();
  all[tripKey()] = c || state.currency;
  try { localStorage.setItem(SHOW_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
  if (displayCurrency() !== state.currency) await loadFx();
  then();
}

/** The rates have come in (once they have, nothing needs drawing again for them). */
export let fxReady = false;

export const ro = () => isReadOnly();
/** The travelers by name (none: not named, or one traveler). */
export const people = () => state.people || [];
/** Several travel, but nobody's named: splitting costs needs names. */
export const needNames = () => (Number(state.travelers) || 1) > 1 && !people().length;

export const rows = (): Row[] => Object.entries(state.expenses || {}).map(([id, e]) => ({ ...e, id }))
  .sort((a, b) => a.date.localeCompare(b.date) || (a.at || 0) - (b.at || 0));
export const linked = (link: string): Row | undefined => rows().find((e) => e.link === link);

export const stopLink = (date: string, place: string) => `stop:${date}|${place}`;

/** What was really paid for each thing in the trip (by its link), in the trip's currency: shown in the plan in place of
 *  the estimate. */
export function paidByLink(): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of Object.values(state.expenses || {})) {
    if (!e.link || e.kind === "settle") continue;
    const v = inTrip(e, state.currency, fx);
    if (v != null) out.set(e.link, (out.get(e.link) || 0) + v);
  }
  return out;
}
export const stayLink = (city: string, start: string) => `stay:${city}|${start}`;
export const bookingLink = (name: string, date: string) => `booking:${name}|${date}`;

/** The plan's kind of stop as a kind of expense. */
export const kindOf = (k: ItineraryItem["kind"]): ExpenseKind => (k === "meal" ? "food" : k === "sight" || k === "activity" ? "sights" : k === "transfer" ? "transport" : "other");

/** What new expenses start with: the last ones entered. */
export const last = { paidBy: "", currency: "", date: "", kind: "food" as ExpenseKind };
export const defaultPayer = () => (people().includes(last.paidBy) ? last.paidBy : people()[0] || "");

/** The trip's days, first to last (from the plan, else the stays). */
export function tripDates(): [string, string] {
  const days = state.itinerary?.days.map((d) => d.date).filter(Boolean) || [];
  if (days.length) return [days[0], days[days.length - 1]];
  const s = state.stays.filter((x) => x.start);
  if (!s.length) return ["", ""];
  const end = new Date(s[s.length - 1].start); end.setDate(end.getDate() + Number(s[s.length - 1].nights || 0));
  return [s[0].start, end.toLocaleDateString("sv")];
}
/** Today during the trip, else the last date used, else the first day. */
export function defaultDate() {
  const [a, b] = tripDates(), t = todayIso();
  return a && t >= a && t <= b ? t : last.date || a || t;
}

/** An amount as typed for a currency (no decimals for yen). */
export const amountText = (n: number | undefined, cur: string) => (n == null || isNaN(n) ? "" : String(Math.round(n * 10 ** decimals(cur)) / 10 ** decimals(cur)));
export const step = (cur: string) => (decimals(cur) ? "0.01" : "1");

// ---- Changing -------------------------------------------------------------------------------------------------------------
let redraw = () => {};
let undoNote: { text: string; undo: () => void } | null = null;
export let changed = false;
export const setRedraw = (f: () => void) => { redraw = f; };
export const resetChanged = () => { changed = false; undoNote = null; };
export const takeUndo = () => undoNote;
export const clearUndo = () => { undoNote = null; };
/** A note in the window with Undo, for a change that isn't removing one expense (expenses brought in from the phone). */
export const noteUndo = (text: string, undo: () => void) => { undoNote = { text, undo: () => { undoNote = null; undo(); touched(); } }; };

/** Something in the trip changed: saved, and the window drawn again once focus has moved on (so Tab still works). */
export function touched() {
  changed = true;
  save();
  setTimeout(redraw);
}

export function putExpense(id: string | null, e: Expense) {
  const key = id || expenseId();
  state.expenses = { ...(state.expenses || {}), [key]: { ...e, at: e.at || Date.now() } };
  last.paidBy = e.paidBy || last.paidBy; last.date = e.date; if (e.kind !== "settle") { last.currency = e.currency; last.kind = e.kind || last.kind; }
  touched();
  return key;
}

export function dropExpense(id: string, what = "") {
  const was = state.expenses?.[id];
  if (!was) return;
  const next = { ...state.expenses };
  delete next[id];
  state.expenses = Object.keys(next).length ? next : undefined;
  undoNote = { text: `Removed ${what || (was.kind === "settle" ? "the payment" : `“${was.what}”`)}`, undo: () => { state.expenses = { ...(state.expenses || {}), [id]: was }; undoNote = null; touched(); } };
  touched();
}

// ---- How each person stands in an expense --------------------------------------------------------------------------------
/** The choices for someone it was for (other than the payer): owes the payer, covered by the payer, or paid their own. */
export const STANDS: [Stand, string, string][] = [
  ["owes", "Owes", "Owes the payer their share"],
  ["covered", "Covered", "The payer takes their share: they owe nothing"],
  ["own", "Paid own", "Paid their own share themselves: they owe nothing"],
  ["back", "Paid back", "Owed their share and already paid the payer back: they owe nothing more"],
];
/** A small three-way switch for a person; `group` keeps the radio names apart (the form, the row's window). */
export const standPicker = (n: string, st: Stand, group: string) => `<div class="cx-seg" role="radiogroup" aria-label="${esc(n)}">${STANDS.map(([k, t, tip]) =>
  `<label title="${esc(tip)}"${st === k ? ` class="on"` : ""}><input type="radio" name="${esc(`${group}-${n}`)}" data-stand="${esc(n)}" value="${k}"${st === k ? " checked" : ""}>${t}</label>`).join("")}</div>`;
/** Who's covered and who paid their own, from the switches in `root`, among those it was for (not the payer). */
export function readStands(root: HTMLElement, forWho: string[], payer: string) {
  const picked = (k: Stand) => [...root.querySelectorAll<HTMLInputElement>(`[data-stand]:checked`)].filter((b) => b.value === k && forWho.includes(b.dataset.stand!) && b.dataset.stand !== payer).map((b) => b.dataset.stand!);
  return { covered: picked("covered"), own: picked("own"), back: picked("back") };
}
