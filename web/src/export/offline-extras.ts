// The phone file as a small app for the trip, when the computer isn't running. Three views behind tabs at the top:
// Today (one day on its own: its stops with tick boxes, directions and what was paid for each, the day's bookings and
// the weather saved with the file), Plan (the whole itinerary and its map, as before), and Expenses (what was spent,
// who owes whom with Mark as paid, every expense to change, and an expense sheet like the app's: a stop of the plan,
// who paid, who it was for and how each stands). It starts from the app's expenses; "Send to the app" hands back what
// changed, and Costs → Expenses → Import from phone merges it (shared/expenses.ts mergeFromPhone).
import { CURRENCIES, fmtTemps } from "../core/format";
import { session, state } from "../core/state";
import { KINDS } from "../../../shared/expenses";
import { directionsUrl } from "../itinerary/directions";
import { wmoIcon } from "../itinerary/weather";
import { fx, kindOf, stopLink } from "../itinerary/costs-data";

/** What a file of expenses from the phone says it is. */
export const PHONE_EXPENSES = "trip-planner-expenses";

export function phoneExtrasData() {
  const it = state.itinerary!;
  const bookingsOn = (date: string) => (state.bookings || []).filter((b) => b.name && b.date && date >= b.date && date <= (b.until || b.date))
    .map((b) => ({ n: b.name, from: b.from || "", to: b.to || "", where: b.where || "" }));
  return {
    // Which trip it is (two trips' files keep their ticks and expenses apart), its name, and when the file was made.
    id: state.sync?.id || state.saveName || it.destination || "trip",
    name: state.saveName || it.destination || "trip",
    at: Date.now(),
    people: state.people || [],
    // How many travel (the phone asks for their names when the trip has none), and the journal so far.
    travelers: Number(state.travelers) || 1,
    journal: state.journal || {},
    currency: state.currency,
    currencies: [...new Set([it.localCurrency || "", state.currency, ...CURRENCIES].filter(Boolean))],
    local: it.localCurrency || state.currency,
    rates: fx,
    kinds: KINDS,
    // The app's expenses when the file was made: the phone starts from them, and they're what its changes are against.
    expenses: state.expenses || {},
    days: it.days.map((d, i) => {
      const w = session.weather[d.date];
      return {
        date: d.date, n: i + 1, city: d.city.split(",")[0], title: d.title,
        w: w ? { i: wmoIcon(w.code), t: fmtTemps(w.min, w.max), typical: w.kind === "typical" } : null,
        stops: d.items.map((x, xi) => ({
          t: (x.time || "").slice(0, 5), p: x.place.split(",")[0], dir: directionsUrl(i, xi) || "", k: `${i}-${xi}`,
          link: stopLink(d.date, x.place), est: Number(x.cost) || 0, kind: kindOf(x.kind), who: (x.who || []).filter((n) => (state.people || []).includes(n)),
        })),
        bookings: bookingsOn(d.date),
      };
    }),
  };
}

export const EXTRAS_CSS = `
  body { padding-bottom: 80px; }
  .ph-top { position: sticky; top: 0; z-index: 1002; display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 12px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .ph-top b { flex: 1; min-width: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ph-tabs { display: flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--field); }
  .ph-tabs button { height: 32px; padding: 0 12px; border: 0; border-radius: 999px; background: none; color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; }
  .ph-tabs button.on { background: var(--panel); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .ph-view[hidden] { display: none !important; }
  #vPlan .daynav { top: 52px; }
  #vPlan .day { scroll-margin-top: 104px; }
  .ph-page { max-width: 640px; margin: 0 auto; padding: 14px 14px 24px; display: grid; gap: 14px; }
  .ph-card { padding: 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
  .ph-daybar { display: flex; align-items: center; gap: 8px; }
  .ph-daybar h2 { display: block; flex: 1; margin: 0; text-align: center; font-size: 16px; text-transform: none; letter-spacing: 0; color: var(--ink); }
  .ph-daybar h2 small { display: block; font-size: 12.5px; font-weight: 500; color: var(--muted); }
  .ph-round { flex: none; width: 40px; height: 40px; border: 1px solid var(--line); border-radius: 50%; background: var(--panel); color: var(--ink); font-size: 18px; }
  .ph-round:disabled { opacity: .35; }
  .ph-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid var(--accent); border-radius: 999px; background: none; color: var(--accent); font: inherit; font-size: 12.5px; font-weight: 600; }
  .ph-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--muted); font-size: 13px; }
  .ph-meta .w { display: inline-flex; align-items: center; gap: 5px; }
  .ph-meta svg { width: 16px; height: 16px; }
  .ph-book { display: grid; gap: 4px; font-size: 13.5px; }
  .ph-stops { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .ph-stop { padding: 10px 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); display: grid; gap: 8px; }
  .ph-stop.next { border-color: var(--accent); box-shadow: inset 4px 0 0 var(--accent); }
  .ph-stop.done { opacity: .6; }
  .ph-stop.done .ph-name { text-decoration: line-through; }
  .ph-row { display: flex; align-items: center; gap: 10px; }
  .ph-row input[type=checkbox] { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--accent); }
  .ph-time { flex: none; width: 44px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .ph-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; }
  .ph-next { margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 10.5px; font-weight: 700; text-transform: uppercase; vertical-align: 1px; }
  .ph-acts { display: flex; gap: 8px; padding-left: 32px; }
  .ph-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--field); color: var(--ink); font: inherit; font-size: 13px; font-weight: 600; text-decoration: none; }
  .ph-btn.paid { border-color: color-mix(in srgb, var(--ok) 50%, var(--line)); background: var(--ok-soft); color: var(--ok); flex: 1; justify-content: flex-start; text-align: left; }
  .ph-btn.add { color: var(--accent); }
  .ph-btn.wide { width: 100%; min-height: 46px; font-size: 14.5px; }
  .ph-btn.solid { border: 0; background: var(--accent); color: #fff; }
  .ph-btn.danger { color: var(--warn); }
  .ph-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ph-stat { padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  .ph-stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
  .ph-stat span { font-size: 12px; color: var(--muted); }
  .ph-stat.warn b { color: var(--warn); }
  .ph-h { margin: 6px 2px 0; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; display: flex; justify-content: space-between; }
  .ph-pay { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); font-size: 14px; }
  .ph-pay .amt { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ph-list { display: grid; gap: 6px; }
  .ph-ex { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); font: inherit; text-align: left; }
  .ph-ex span { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; }
  .ph-ex small { display: block; font-weight: 400; font-size: 12px; color: var(--muted); }
  .ph-ex b { font-variant-numeric: tabular-nums; font-size: 14px; }
  .ph-ex.changed { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
  .ph-note { margin: 0; font-size: 12.5px; color: var(--muted); }
  .ph-send { display: flex; align-items: center; gap: 12px; padding: 12px 12px 12px 14px; border: 1px solid var(--accent); border-radius: 14px; background: color-mix(in srgb, var(--accent) 9%, var(--panel)); }
  .ph-send div { flex: 1; min-width: 0; display: grid; gap: 3px; }
  .ph-send b { font-size: 14px; }
  .ph-send span { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .ph-send .ph-btn { flex: none; min-height: 40px; padding: 0 18px; }
  .ph-fab { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 1100; height: 48px; padding: 0 20px; border: 0; border-radius: 999px; background: var(--accent); color: #fff; font: inherit; font-weight: 700; font-size: 14.5px; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
  .ph-fab[hidden] { display: none; }
  .ph-sheet { width: 100vw; max-width: 640px; height: 100dvh; max-height: 100dvh; margin: 0 auto; padding: 0; border: 0; background: var(--bg); color: var(--ink); }
  .ph-sheet::backdrop { background: rgba(0,0,0,.5); }
  .ph-form { min-height: 100%; box-sizing: border-box; padding: 0 14px calc(20px + env(safe-area-inset-bottom)); display: grid; align-content: start; gap: 12px; }
  .ph-form-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; height: 54px; margin: 0 -14px; padding: 0 14px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .ph-form-head h2 { flex: 1; margin: 0; font-size: 16px; text-transform: none; letter-spacing: 0; color: var(--ink); }
  .ph-form label.f { display: grid; gap: 5px; margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); }
  .ph-form input:not([type=checkbox]):not([type=radio]), .ph-form select { width: 100%; box-sizing: border-box; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--field); color: var(--ink); font: inherit; font-size: 16px; }
  .ph-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .ph-money { display: grid; grid-template-columns: 1fr 104px; gap: 8px; }
  .ph-rate { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .ph-form .ph-rate input { width: 100px; height: 36px; font-size: 14px; }
  .ph-split { display: grid; gap: 8px; }
  .ph-split-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .ph-split-head span { color: var(--muted); font-size: 12.5px; }
  .ph-person { padding: 10px 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); display: grid; gap: 8px; }
  .ph-person.out { opacity: .55; border-style: dashed; }
  .ph-person-top { display: flex; align-items: center; gap: 10px; }
  .ph-person-top label { flex: 1; display: flex; align-items: center; gap: 10px; margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); }
  .ph-person-top input { width: 22px; height: 22px; margin: 0; accent-color: var(--accent); }
  .ph-person-top .amt { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
  .ph-person-top .amt b { display: block; color: var(--ink); font-size: 14.5px; }
  .ph-badge { padding: 1px 7px; border-radius: 6px; background: var(--ok-soft); color: var(--ok); font-size: 10.5px; font-weight: 700; text-transform: uppercase; }
  .ph-seg { display: flex; padding: 3px; border: 1px solid var(--line); border-radius: 12px; background: var(--field); }
  .ph-seg label { flex: 1; display: flex; align-items: center; justify-content: center; height: 34px; margin: 0; border-radius: 9px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
  .ph-seg input { position: absolute; opacity: 0; width: 0; height: 0; }
  .ph-seg label:has(input:checked) { background: var(--panel); color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .ph-seg label:has(input[value=covered]:checked) { background: var(--accent); color: #fff; }
  .ph-seg label:has(input[value=own]:checked), .ph-seg label:has(input[value=back]:checked) { background: var(--ok-soft); color: var(--ok); }
  .ph-err { margin: 0; color: var(--warn); font-size: 13.5px; }
  .ph-form-foot { display: grid; gap: 8px; margin-top: 6px; }
  .ph-nojs { margin: 10px 14px; padding: 10px 12px; border: 1px solid var(--warn); border-radius: 12px; font-size: 13.5px; line-height: 1.45; }
  .ph-journal, .ph-names { display: grid; gap: 8px; }
  .ph-journal textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--field); color: var(--ink); font: inherit; font-size: 15px; line-height: 1.45; resize: vertical; }
  .ph-share { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0; font-size: 12.5px; color: var(--muted); }
  .ph-share[hidden] { display: none; }
  .ph-share { white-space: nowrap; }
  .ph-form .ph-share input[data-share] { flex: none; width: 130px; height: 38px; font-size: 14.5px; }
  @media print { .ph-top, .ph-fab, #vToday, #vMoney { display: none !important; } #vPlan { display: block !important; } }`;

/** Plain JavaScript inside the phone file (EXTRAS is its data). */
export const EXTRAS_SCRIPT = `
(function () {
  const X = EXTRAS; let P = X.people, many = P.length > 1;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const today = () => new Date().toLocaleDateString("sv");
  const toMin = (t) => { const m = /^(\\d{1,2}):(\\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const dec = (c) => (["JPY", "KRW", "VND", "IDR", "HUF", "ISK", "CLP", "TWD"].includes(c) ? 0 : 2);
  const money = (n, c) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: c, maximumFractionDigits: dec(c) }).format(n); } catch (e) { return Math.round(n) + " " + c; } };
  const dayLabel = (date) => { try { return new Date(date + "T12:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); } catch (e) { return date; } };
  const kindName = (k) => (X.kinds.find((x) => x[0] === k) || [0, k === "settle" ? "Paid back" : "Other"])[1];
  const newId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x));
  const same = (a, b) => stable(a) === stable(b);

  // ---- What's kept in this browser, per trip: ticks, the expenses, and what the file they came from had. ----
  const store = (() => { try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return localStorage; } catch (e) { return null; } })();
  const KEY = "trip-phone:" + X.id;
  let S = { done: {}, expenses: null, base: null, fileAt: 0, view: "", journal: {}, sent: {}, people: null };
  try { S = Object.assign(S, JSON.parse((store && store.getItem(KEY)) || "{}")); } catch (e) {}
  // A newer file from the app: its expenses joined with what was changed here since (per expense; the phone's wins).
  if (!S.expenses || S.fileAt < X.at) {
    const base = S.base || {}, mine = S.expenses || {}, app = X.expenses, out = {};
    new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(app)]).forEach((id) => {
      const b = base[id], m = mine[id], a = app[id];
      const v = S.expenses && !same(m, b) ? m : a;
      if (v) out[id] = v;
    });
    S.expenses = out; S.base = JSON.parse(JSON.stringify(app)); S.fileAt = X.at;
  }
  const persist = () => { try { store && store.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  // The travelers named here, for a trip whose file came without names.
  if (!X.people.length && S.people && S.people.length > 1) { P = S.people; many = true; }
  // The journal: the app's entries, and the ones written here (of each day, the one written last). "sent": the entry's
  // time as the app has it.
  S.journal = S.journal || {}; S.sent = S.sent || {};
  Object.keys(X.journal || {}).forEach((d) => { const a = X.journal[d], m = S.journal[d]; if (a && (!m || (a.at || 0) >= (m.at || 0))) { S.journal[d] = { text: a.text || "", at: a.at || 0 }; S.sent[d] = a.at || 0; } });
  const unsentJournal = () => Object.keys(S.journal).filter((d) => (S.journal[d].text || "").trim() && S.sent[d] !== S.journal[d].at).length;
  persist();

  // ---- Money: the same rules as the app (shared/expenses.ts). ----
  const whoOf = (e) => (e.split && e.split.length ? e.split : P);
  function inTrip(e) {
    const c = X.currency, amt = +e.amount || 0;
    if (!e.currency || e.currency === c) return amt;
    if (e.rate && e.rateTo === c) return amt * e.rate;
    const a = e.currency === "EUR" ? 1 : X.rates[e.currency], b = c === "EUR" ? 1 : X.rates[c];
    return a && b ? (amt / a) * b : null;
  }
  function stand(e, n) {
    if (!e.each && n === e.paidBy) return "payer";
    if (!whoOf(e).includes(n)) return "out";
    if (e.each) return "own";
    if (!e.paidBy) return "owes";
    if ((e.own || []).includes(n)) return "own";
    if ((e.back || []).includes(n)) return "back";
    if ((e.covered || []).includes(n)) return "covered";
    return "owes";
  }
  const list = () => Object.entries(S.expenses).map(([id, e]) => Object.assign({ id: id }, e)).sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
  // Each one's part, as in the app (shared/expenses.ts, partsOf): set by hand, else an even share of what's left.
  function partsOf(e, who) {
    const set = {}, out = {}; let fixed = 0;
    Object.keys(e.shares || {}).forEach((n) => { const v = +e.shares[n]; if (who.includes(n) && isFinite(v) && v >= 0) { set[n] = v; fixed += v; } });
    const free = who.filter((n) => !(n in set));
    who.forEach((n) => { out[n] = n in set ? set[n] : Math.max(0, (+e.amount || 0) - fixed) / free.length; });
    return out;
  }
  function balances() {
    const out = {}; P.forEach((n) => (out[n] = 0));
    list().forEach((e) => {
      const v = inTrip(e), who = whoOf(e);
      if (v == null || e.each || !e.paidBy || !who.length) return;
      const pt = partsOf(e, who), tot = who.reduce((t, n) => t + pt[n], 0); let even = 0;
      who.forEach((n) => { const sh = tot > 0 ? (pt[n] / tot) * v : v / who.length, st = stand(e, n); if (st === "own" || st === "back") { even += sh; return; } const to = st === "covered" ? e.paidBy : n; out[to] = (out[to] || 0) - sh; });
      out[e.paidBy] = (out[e.paidBy] || 0) + v - even;
    });
    return out;
  }
  function settle(bal) {
    const tiny = 0.5 / Math.pow(10, dec(X.currency)), f = Math.pow(10, dec(X.currency));
    const owe = Object.entries(bal).filter((x) => x[1] < -tiny).map((x) => ({ n: x[0], v: -x[1] })).sort((a, b) => b.v - a.v);
    const get = Object.entries(bal).filter((x) => x[1] > tiny).map((x) => ({ n: x[0], v: x[1] })).sort((a, b) => b.v - a.v);
    const out = []; let i = 0, j = 0;
    while (i < owe.length && j < get.length) {
      const pay = Math.min(owe[i].v, get[j].v), amt = Math.round(pay * f) / f;
      if (amt > tiny) out.push({ from: owe[i].n, to: get[j].n, amount: amt });
      owe[i].v -= pay; get[j].v -= pay;
      if (owe[i].v <= tiny) i++;
      if (get[j].v <= tiny) j++;
    }
    return out;
  }
  const spent = () => list().filter((e) => e.kind !== "settle").reduce((t, e) => t + (inTrip(e) || 0), 0);
  const byLink = (link) => list().find((e) => e.link === link);
  /** "Mia paid · covers Tom" for an expense. */
  function said(e) {
    if (e.kind === "settle") return (e.paidBy || "?") + " → " + ((e.split || [])[0] || "?");
    if (!many) return kindName(e.kind);
    const who = whoOf(e), parts = [e.each ? "each paid their own" : e.paidBy ? e.paidBy + " paid" : "nobody said who paid"];
    if (who.length < P.length) parts.push("for " + who.join(", "));
    const by = (st) => who.filter((n) => stand(e, n) === st);
    if (by("covered").length) parts.push("covers " + by("covered").join(", "));
    if (!e.each && by("own").length) parts.push(by("own").join(", ") + " paid own");
    if (by("back").length) parts.push(by("back").join(", ") + " paid back");
    return parts.join(" · ");
  }
  /** Expenses changed here since the file was made (what "Send to the app" carries). */
  const changes = () => new Set([...Object.keys(S.expenses), ...Object.keys(S.base)]).size && [...new Set([...Object.keys(S.expenses), ...Object.keys(S.base)])].filter((id) => !same(S.expenses[id], S.base[id])).length;

  // ---- Views ----
  const views = { today: $("#vToday"), plan: $("#vPlan"), money: $("#vMoney") };
  const tabs = $$(".ph-tabs button"), fab = $(".ph-fab");
  const tripDay = () => X.days.find((d) => d.date === today());
  let shown = "", dayIdx = Math.max(0, X.days.findIndex((d) => d.date >= today()));
  if (tripDay()) dayIdx = X.days.indexOf(tripDay());
  let planShown = false;
  function show(v) {
    shown = v; S.view = v; persist();
    Object.entries(views).forEach(([k, el]) => (el.hidden = k !== v));
    tabs.forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    fab.hidden = v === "plan";
    if (v === "today") drawToday();
    if (v === "money") drawMoney();
    if (v === "plan" && !planShown && window.__phoneMapShow) { planShown = true; setTimeout(window.__phoneMapShow, 0); }
    window.scrollTo(0, 0);
  }
  tabs.forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

  // ---- Today ----
  function drawToday() {
    const d = X.days[dayIdx]; if (!d) { views.today.innerHTML = '<div class="ph-page"><p class="ph-note">No days in the plan.</p></div>'; return; }
    const isToday = d.date === today(), done = S.done[d.date] || {}, now = new Date().getHours() * 60 + new Date().getMinutes();
    let next = isToday ? d.stops.findIndex((s, i) => !done[i] && (toMin(s.t) == null || toMin(s.t) >= now - 45)) : -1;
    if (isToday && next < 0) next = d.stops.findIndex((s, i) => !done[i]);
    const td = tripDay();
    views.today.innerHTML = '<div class="ph-page">'
      + '<div class="ph-daybar"><button class="ph-round" data-day="-1"' + (dayIdx ? "" : " disabled") + ' aria-label="Day before">‹</button>'
      + "<h2>" + (isToday ? "Today" : "Day " + d.n) + "<small>" + (isToday ? "Day " + d.n + " · " : "") + esc(dayLabel(d.date)) + " · " + esc(d.city) + "</small></h2>"
      + '<button class="ph-round" data-day="1"' + (dayIdx < X.days.length - 1 ? "" : " disabled") + ' aria-label="Next day">›</button></div>'
      + (td && !isToday ? '<div style="text-align:center"><button class="ph-chip" data-jump>Back to today</button></div>' : "")
      + '<div class="ph-meta">' + (d.title ? "<span>" + esc(d.title) + "</span>" : "") + (d.w ? '<span class="w" title="' + (d.w.typical ? "Typical for the date" : "Forecast when the file was made") + '">' + d.w.i + esc(d.w.t) + "</span>" : "") + "</div>"
      + (d.bookings.length ? '<div class="ph-card ph-book">' + d.bookings.map((b) => "<div><b>" + esc(b.n) + "</b>" + (b.from ? " · " + esc(b.from) + (b.to ? "–" + esc(b.to) : "") : "") + (b.where ? " · " + esc(b.where) : "") + "</div>").join("") + "</div>" : "")
      + '<ul class="ph-stops">' + d.stops.map((s, i) => {
        const e = byLink(s.link);
        const paid = e ? '<button class="ph-btn paid" data-edit="' + esc(e.id) + '">✓ ' + esc(money(e.amount, e.currency)) + (many ? " · " + esc(said(e)) : "") + "</button>"
          : '<button class="ph-btn add" data-stop="' + i + '">+ Paid' + (s.est ? " · est. " + esc(money(s.est, X.currency)) : "") + "</button>";
        return '<li class="ph-stop' + (done[i] ? " done" : "") + (i === next ? " next" : "") + '"><div class="ph-row"><input type="checkbox" data-done="' + i + '"' + (done[i] ? " checked" : "") + ' aria-label="Done">'
          + '<span class="ph-time">' + esc(s.t) + '</span><span class="ph-name">' + esc(s.p) + (i === next ? '<span class="ph-next">next</span>' : "") + "</span></div>"
          + '<div class="ph-acts">' + paid + (s.dir ? '<a class="ph-btn" href="' + esc(s.dir) + '" target="_blank" rel="noopener">Route ↗</a>' : "") + "</div></li>";
      }).join("") + "</ul>"
      + '<button class="ph-btn wide" data-other>+ Another expense this day</button>'
      + '<div class="ph-card ph-journal"><b>Journal</b><span class="ph-note">What did you really do? Write it loosely: where you went, what you skipped and why, how you got around, who paid what. At home the app works it out into the day as it went.</span>'
      + '<textarea data-journal rows="5" placeholder="e.g. Skipped the castle, went to the market instead. Lunch at a small cafe, I paid 24 for both of us…">' + esc((S.journal[d.date] || {}).text || "") + "</textarea>"
      + '<div class="ph-row" data-journal-send' + (unsentJournal() ? "" : " hidden") + '><span class="ph-note" style="flex:1">Not in the app yet</span><button type="button" class="ph-btn" data-send>Send</button></div></div>'
      + (store ? "" : '<p class="ph-note">This viewer can\\'t keep anything: open the file in your browser (Chrome, Safari) to keep ticks and expenses.</p>')
      + "</div>";
    $$("[data-day]", views.today).forEach((b) => b.onclick = () => { dayIdx = Math.min(X.days.length - 1, Math.max(0, dayIdx + +b.dataset.day)); drawToday(); });
    const jump = $("[data-jump]", views.today); if (jump) jump.onclick = () => { dayIdx = X.days.indexOf(tripDay()); drawToday(); };
    $$("[data-done]", views.today).forEach((b) => b.onchange = () => { const t = d.date; S.done[t] = S.done[t] || {}; if (b.checked) S.done[t][b.dataset.done] = true; else delete S.done[t][b.dataset.done]; persist(); drawToday(); markPlan(); });
    $$("[data-stop]", views.today).forEach((b) => b.onclick = () => openSheet(null, { stop: [dayIdx, +b.dataset.stop] }));
    $$("[data-edit]", views.today).forEach((b) => b.onclick = () => openSheet(b.dataset.edit));
    $("[data-other]", views.today).onclick = () => openSheet(null, { date: d.date });
    const jt = $("[data-journal]", views.today);
    // Kept as they type (the view isn't drawn again meanwhile: the box keeps its place).
    jt.oninput = () => { if (jt.value.trim()) S.journal[d.date] = { text: jt.value, at: Date.now() }; else delete S.journal[d.date]; persist(); $("[data-journal-send]", views.today).hidden = !unsentJournal(); };
    $("[data-send]", views.today).onclick = sendAll;
  }
  function markPlan() {
    $$(".item.done").forEach((el) => el.classList.remove("done"));
    Object.keys(S.done).forEach((date) => { const d = X.days.find((x) => x.date === date); if (d) Object.keys(S.done[date]).forEach((i) => { const s = d.stops[i], el = s && $('.item[data-k="' + s.k + '"]'); if (el) el.classList.add("done"); }); });
  }

  // ---- Expenses ----
  function drawMoney() {
    const items = list(), bal = balances(), pay = settle(bal), n = changes() + unsentJournal();
    const groups = {}; items.forEach((e) => (groups[e.date] = groups[e.date] || []).push(e));
    views.money.innerHTML = '<div class="ph-page">'
      + '<div class="ph-stats"><div class="ph-stat"><b>' + esc(money(spent(), X.currency)) + "</b><span>spent in all</span></div>"
      + '<div class="ph-stat' + (pay.length ? " warn" : "") + '"><b>' + (pay.length ? esc(money(pay.reduce((t, p) => t + p.amount, 0), X.currency)) : "Even") + "</b><span>" + (pay.length ? "still to pay back" : "nobody owes anybody") + "</span></div></div>"
      // What's changed here and not in the app yet: a card at the top, with Send.
      + (n ? '<div class="ph-send"><div><b>' + n + " change" + (n === 1 ? "" : "s") + " not in the app yet</b><span>Send a small file and open it in the planner: Costs → Expenses → Import from phone (journal entries: Journal → Import from phone).</span></div>"
        + '<button class="ph-btn solid" data-send>Send</button></div>' : "")
      + (many && pay.length ? '<div class="ph-h">Settle up</div>' + pay.map((p, i) => '<div class="ph-pay"><b>' + esc(p.from) + "</b> → <b>" + esc(p.to) + '</b><span class="amt">' + esc(money(p.amount, X.currency)) + '</span><button class="ph-btn" data-settle="' + i + '">✓ Paid</button></div>').join("") : "")
      + '<div class="ph-h"><span>Expenses</span><span>' + items.filter((e) => e.kind !== "settle").length + "</span></div>"
      + (items.length ? Object.keys(groups).map((date) => '<div class="ph-h" style="text-transform:none;letter-spacing:0">' + esc(dayLabel(date)) + "</div>"
        + '<div class="ph-list">' + groups[date].map((e) => '<button class="ph-ex' + (same(S.expenses[e.id], S.base[e.id]) ? "" : " changed") + '" data-edit="' + esc(e.id) + '"><span>' + esc(e.kind === "settle" ? "Paid back" : e.what) + "<small>" + esc(said(e)) + "</small></span><b>" + esc(money(e.amount, e.currency)) + "</b></button>").join("") + "</div>").join("")
        : '<p class="ph-note">Nothing yet. Add what you pay with + Expense, or next to a stop under Today.</p>')
      + (items.length && !n ? '<p class="ph-note">Everything here is in the app already.</p>' : "")
      + "</div>";
    $$("[data-edit]", views.money).forEach((b) => b.onclick = () => openSheet(b.dataset.edit));
    $$("[data-settle]", views.money).forEach((b) => b.onclick = () => { const p = pay[+b.dataset.settle]; S.expenses[newId()] = { what: p.from + " paid " + p.to + " back", amount: p.amount, currency: X.currency, date: today(), paidBy: p.from, split: [p.to], kind: "settle", at: Date.now() }; persist(); drawMoney(); });
    const send = $("[data-send]", views.money); if (send) send.onclick = sendAll;
  }
  async function sendAll() {
    // The journal, each day with the stops ticked as done.
    const journal = {};
    new Set(Object.keys(S.journal).concat(Object.keys(S.done))).forEach((date) => {
      const e = S.journal[date] || {}, day = X.days.find((x) => x.date === date);
      const ticks = day ? Object.keys(S.done[date] || {}).map((i) => day.stops[i] && day.stops[i].p).filter(Boolean) : [];
      if ((e.text || "").trim() || ticks.length) journal[date] = { text: e.text || "", at: e.at || 1, done: ticks };
    });
    const body = JSON.stringify({ kind: "${PHONE_EXPENSES}", trip: X.id, at: Date.now(), base: S.base, expenses: S.expenses, journal: journal, people: X.people.length ? undefined : P });
    const name = (X.name + "-from-phone-" + today()).replace(/[^\\p{L}\\p{N}-]+/gu, "-") + ".json";
    const file = new File([body], name, { type: "application/json" });
    const sent = () => { Object.keys(S.journal).forEach((d) => (S.sent[d] = S.journal[d].at)); persist(); redraw(); };
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Trip journal and expenses" }); sent(); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; a.click();
    sent();
  }

  // ---- The expense sheet ----
  const sheet = document.createElement("dialog"); sheet.className = "ph-sheet"; document.body.append(sheet);
  const opt = (v, t, sel) => '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + ">" + esc(t) + "</option>";
  let last = { cur: X.local, paidBy: P[0] || "", kind: "food" };
  function openSheet(id, preset) {
    const was = id ? S.expenses[id] : null, pre = preset || {};
    const stop = pre.stop ? X.days[pre.stop[0]].stops[pre.stop[1]] : null, stopDay = pre.stop ? X.days[pre.stop[0]] : null;
    const e = was ? JSON.parse(JSON.stringify(was)) : {
      what: stop ? stop.p : "", amount: stop && stop.est ? stop.est : "", currency: stop ? X.currency : last.cur, date: stopDay ? stopDay.date : pre.date || today(),
      kind: stop ? stop.kind : last.kind, link: stop ? stop.link : undefined, paidBy: last.paidBy, split: stop && stop.who.length ? stop.who.slice() : undefined,
    };
    const linkOpts = X.days.map((d) => d.stops.length ? '<optgroup label="' + esc("Day " + d.n + " · " + dayLabel(d.date) + " · " + d.city) + '">' + d.stops.map((s) => opt(s.link, (s.t ? s.t + " " : "") + s.p, e.link || "")).join("") + "</optgroup>" : "").join("");
    const payer = e.each ? "__each" : e.paidBy || "";
    sheet.innerHTML = '<form class="ph-form">'
      + '<div class="ph-form-head"><button type="button" class="ph-round" data-close aria-label="Close">×</button><h2>' + (was ? "Change expense" : "Add an expense") + "</h2></div>"
      + (!many && X.travelers > 1 ? '<div class="ph-card ph-names"><b>Who is travelling?</b><span class="ph-note">Name the travelers to say who paid, who it was for and how each stands.</span>'
        + Array.from({ length: Math.min(12, X.travelers) }).map((_, i) => '<input data-name placeholder="Traveler ' + (i + 1) + '" maxlength="40" autocomplete="off">').join("")
        + '<button type="button" class="ph-btn" data-names>Use these names</button></div>' : "")
      + '<label class="f">From the plan<select name="link"><option value="">— Something else —</option>' + linkOpts + "</select></label>"
      + '<label class="f">What<input name="what" value="' + esc(e.what) + '" placeholder="e.g. Ramen for everyone" maxlength="120" autocomplete="off"></label>'
      + '<div class="ph-money"><label class="f">Full amount<input name="amount" type="number" inputmode="decimal" min="0" step="any" value="' + esc(e.amount) + '" required></label>'
      + '<label class="f">Currency<select name="cur">' + X.currencies.map((c) => opt(c, c, e.currency)).join("") + "</select></label></div>"
      + '<div class="ph-rate" data-ratebox hidden>1 <span data-ratecur></span> =<input name="rate" type="number" inputmode="decimal" step="any" min="0"> ' + esc(X.currency) + ' <b data-conv></b></div>'
      + '<div class="ph-two"><label class="f">Day<input name="date" type="date" value="' + esc(e.date) + '"></label><label class="f">Kind<select name="kind">' + X.kinds.map((k) => opt(k[0], k[1], e.kind || "other")).join("") + "</select></label></div>"
      + (many ? '<label class="f">Paid by<select name="paidBy">' + P.map((n) => opt(n, n, payer)).join("") + opt("__each", "Each paid their own", payer) + "</select></label>"
        + '<div class="ph-split"><div class="ph-split-head"><b>Split between</b><span data-sum></span></div>'
        + P.map((n) => { const st = was ? stand(e, n) : (whoOf(e).includes(n) ? "owes" : "out"); const pick = st === "payer" || st === "out" ? "owes" : st;
          return '<div class="ph-person" data-person="' + esc(n) + '"><div class="ph-person-top"><label><input type="checkbox" data-for="' + esc(n) + '"' + (whoOf(e).includes(n) ? " checked" : "") + ">" + esc(n) + ' <span class="ph-badge" hidden>paid</span></label><span class="amt" data-amt></span></div>'
            + '<div class="ph-seg">' + [["owes", "Owes"], ["covered", "Covered"], ["own", "Paid own"], ["back", "Paid back"]].map((o) => '<label><input type="radio" name="st-' + esc(n) + '" value="' + o[0] + '"' + (pick === o[0] ? " checked" : "") + ">" + o[1] + "</label>").join("") + "</div>"
            + '<label class="ph-share">Their part<input type="number" inputmode="decimal" min="0" step="any" data-share="' + esc(n) + '" value="' + (was && was.shares && was.shares[n] != null ? esc(was.shares[n]) : "") + '" placeholder="even share"></label></div>'; }).join("") + "</div>" : "")
      + '<p class="ph-err" hidden></p>'
      + '<div class="ph-form-foot"><button class="ph-btn solid wide">' + (was ? "Save" : "Add") + "</button>"
      + (was ? '<button type="button" class="ph-btn wide danger" data-del>Remove</button>' : "") + "</div></form>";
    const f = $("form", sheet);
    const rate = () => {
      const c = f.cur.value, box = $("[data-ratebox]", sheet);
      box.hidden = c === X.currency; $("[data-ratecur]", sheet).textContent = c;
      if (c !== X.currency && !f.rate.value) { const a = c === "EUR" ? 1 : X.rates[c], b = X.currency === "EUR" ? 1 : X.rates[X.currency]; if (e.rate && e.rateTo === X.currency && c === e.currency) f.rate.value = e.rate; else if (a && b) f.rate.value = +(b / a).toPrecision(5); }
      const amt = +f.amount.value, r = +f.rate.value; $("[data-conv]", sheet).textContent = c !== X.currency && amt > 0 && r > 0 ? "≈ " + money(amt * r, X.currency) : "";
    };
    const sharesNow = (forWho) => { const o = {}; $$("[data-share]", f).forEach((b) => { if (b.value !== "" && +b.value >= 0 && forWho.includes(b.dataset.share)) o[b.dataset.share] = +b.value; }); return o; };
    const parts = () => {
      if (!many) return;
      const pay = f.paidBy.value, each = pay === "__each", amt = +f.amount.value || 0, c = f.cur.value;
      const forWho = $$("[data-for]", f).filter((b) => b.checked).map((b) => b.dataset.for), sh = forWho.length ? amt / forWho.length : 0;
      // (Amounts set per person in the app are kept, and shown.)
      // Each one's part: as typed here ("Their part"), else an even share of the rest.
      const shares = sharesNow(forWho), pt = partsOf({ amount: amt, shares: shares }, forWho), custom = Object.keys(shares).length > 0;
      const stOf = (n) => (($("input[name='st-" + n + "']:checked", f) || {}).value) || "owes";
      const covered = each ? [] : forWho.filter((n) => n !== pay && stOf(n) === "covered");
      $$("[data-person]", f).forEach((el) => {
        const n = el.dataset.person, isFor = forWho.includes(n), isPayer = !each && n === pay, st = isPayer ? "payer" : !isFor ? "out" : each ? "own" : stOf(n);
        el.classList.toggle("out", !isFor && !isPayer);
        $(".ph-badge", el).hidden = !isPayer;
        $(".ph-seg", el).hidden = isPayer || !isFor || each;
        $(".ph-share", el).hidden = !isFor;
        $("[data-amt]", el).innerHTML = !amt ? "" : isPayer ? "<b>" + esc(money((isFor ? pt[n] : 0) + covered.reduce((t, m) => t + pt[m], 0), c)) + "</b>own part" : !isFor ? "not in it"
          : "<b>" + esc(money(pt[n], c)) + "</b>" + ({ owes: "owes " + esc(pay), covered: "covered", own: "paid own", back: "paid back" })[st];
      });
      $("[data-sum]", f).textContent = forWho.length ? (amt ? (custom ? "set per person for " + forWho.length : money(sh, c) + " each for " + forWho.length) : forWho.length + " of " + P.length) : "nobody";
    };
    f.link.onchange = () => {
      const s = X.days.flatMap((d) => d.stops.map((x) => ({ x: x, d: d }))).find((y) => y.x.link === f.link.value);
      if (!s) return;
      f.what.value = s.x.p; f.date.value = s.d.date; f.kind.value = s.x.kind;
      if (!f.amount.value && s.x.est) f.amount.value = s.x.est;
      if (many) $$("[data-for]", f).forEach((b) => (b.checked = !s.x.who.length || s.x.who.includes(b.dataset.for)));
      rate(); parts();
    };
    f.cur.onchange = () => { f.rate.value = ""; rate(); parts(); };
    f.amount.oninput = () => { rate(); parts(); };
    f.rate.oninput = rate;
    $$("input, select", f).forEach((el) => { if (el.name === "paidBy" || el.dataset.for != null || el.type === "radio") el.addEventListener("change", parts); });
    $$("[data-share]", f).forEach((el) => el.addEventListener("input", parts));
    const useNames = $("[data-names]", sheet);
    if (useNames) useNames.onclick = () => {
      const names = $$("[data-name]", sheet).map((b) => b.value.trim()), err = $(".ph-err", f);
      if (names.some((n) => !n) || new Set(names.map((n) => n.toLowerCase())).size < names.length) { err.textContent = "Give each traveler a name of their own."; err.hidden = false; return; }
      S.people = names; P = names; many = true; last.paidBy = P[0]; persist();
      sheet.close(); openSheet(id, preset);
    };
    rate(); parts();
    $("[data-close]", sheet).onclick = () => sheet.close();
    const del = $("[data-del]", sheet); if (del) del.onclick = () => { delete S.expenses[id]; persist(); sheet.close(); redraw(); };
    f.onsubmit = (ev) => {
      ev.preventDefault();
      const err = $(".ph-err", f), say = (t) => { err.textContent = t; err.hidden = false; };
      const amt = +f.amount.value, c = f.cur.value, r = +f.rate.value;
      if (!(amt > 0)) return say("How much was it?");
      if (c !== X.currency && !(r > 0)) return say("Type what 1 " + c + " is in " + X.currency + ".");
      const out = { what: f.what.value.trim() || kindName(f.kind.value), amount: amt, currency: c, date: f.date.value || today(), kind: f.kind.value, at: (was && was.at) || Date.now() };
      if (c !== X.currency) { out.rate = r; out.rateTo = X.currency; }
      if (f.link.value) out.link = f.link.value;
      if (many) {
        const pay = f.paidBy.value, forWho = $$("[data-for]", f).filter((b) => b.checked).map((b) => b.dataset.for);
        if (!forWho.length) return say("Tick at least one person it was for.");
        if (pay === "__each") out.each = true; else out.paidBy = pay;
        if (forWho.length < P.length) out.split = forWho;
        const kept = sharesNow(forWho);
        if (Object.keys(kept).reduce((t, n) => t + kept[n], 0) > amt + 0.005) return say("The parts add up to more than the amount.");
        if (Object.keys(kept).length) out.shares = kept;
        if (pay !== "__each") ["covered", "own", "back"].forEach((st) => { const l = forWho.filter((n) => n !== pay && (($("input[name='st-" + n + "']:checked", f) || {}).value) === st); if (l.length) out[st] = l; });
        last.paidBy = pay === "__each" ? last.paidBy : pay;
      }
      last.cur = c; last.kind = out.kind;
      S.expenses[id || newId()] = out;
      persist(); sheet.close(); redraw();
    };
    sheet.showModal();
  }
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  const redraw = () => { if (shown === "today") drawToday(); if (shown === "money") drawMoney(); };
  fab.onclick = () => openSheet(null, shown === "today" && X.days[dayIdx] ? { date: X.days[dayIdx].date } : {});

  markPlan();
  // During the trip it opens on today; otherwise where it was left (else the plan).
  show(tripDay() ? "today" : S.view && views[S.view] ? S.view : "plan");
  setInterval(() => { if (shown === "today" && !(document.activeElement && document.activeElement.matches("[data-journal]"))) drawToday(); }, 60000);
})();`;
