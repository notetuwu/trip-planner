// The Costs window, in tabs. Overview: the plan's estimate, what was really spent and the budget, per day and per kind,
// and the fuel estimate. Plan: every stop's estimate to change, and next to it what was really paid and who paid it
// (the same for each stay's accommodation and the bookings). Expenses and Who owes: see costs-spent.ts.
import { type Expense, backBy, coveredBy, inTrip, KINDS, ownBy, partsOf, spending, standOf, unassigned } from "../../../shared/expenses";
import { $, $$, downloadFile, esc } from "../core/dom";
import { currencySymbol, fmtDate, fmtTime, money } from "../core/format";
import { icon } from "../core/icons";
import { fold } from "../core/pick-list";
import { groupBudget, state } from "../core/state";
import { splitGroup } from "../trip/modes";
import { fuelHtml, loadFuelData, wireFuel } from "./fuel";
import { renderItinerary } from "./render";
import {
  amountText, bookingLink, changed, clearUndo, defaultPayer, dropExpense, fx, fxReady, kindOf, last, linked, loadFx, people, putExpense, resetChanged,
  readStands, ro, rows, setRedraw, standPicker, stayLink, step, stopLink, takeUndo, touched, shown, displayPicker, pickDisplayCurrency,
} from "./costs-data";
import { editExpense, oweHtml, setViewRedraw, spentHtml, wireOwe, wireSpent } from "./costs-spent";

export type CostsTab = "overview" | "plan" | "spent" | "owe";
let tab: CostsTab = "overview";

const bar = (v: number, max: number, cls = "") => `<span class="cb-bar${cls ? ` ${cls}` : ""}"><i style="width:${max && v > 0 ? Math.max(2, Math.min(100, (v / max) * 100)) : 0}%"></i></span>`;

// ---- Overview -------------------------------------------------------------------------------------------------------------
function overviewHtml() {
  const it = state.itinerary, cur = state.currency, n = Math.max(1, Number(state.travelers) || 1), days = it?.days || [];
  const est = days.reduce((s, d) => s + (Number(d.estimatedCost) || 0), 0);
  const sum = spending(rows(), people(), cur, fx);
  const perDay = groupBudget(), budget = perDay * days.length, diff = budget - est;
  const paidBookings = (state.bookings || []).filter((b) => b.name && b.cost && !b.countCost).reduce((s, b) => s + (b.cost || 0), 0);
  // The plan's stops by kind of expense, against what was spent on that kind.
  const estKind: Record<string, number> = {};
  for (const d of days) for (const x of d.items) if (Number(x.cost) > 0) estKind[kindOf(x.kind)] = (estKind[kindOf(x.kind)] || 0) + Number(x.cost);
  const kinds = KINDS.filter(([k]) => estKind[k] || sum.byKind[k]);
  const maxKind = Math.max(1, ...kinds.flatMap(([k]) => [estKind[k] || 0, sum.byKind[k] || 0]));
  const maxDay = Math.max(1, perDay, ...days.flatMap((d) => [Number(d.estimatedCost) || 0, sum.byDay[d.date] || 0]));
  const spentAny = sum.total > 0;
  return `<div class="stats cb-stats">
      <div class="stat"><b>${shown(est, cur)}</b><span>the plan's estimate${n > 1 ? ` · ${shown(est / n, cur)} each` : ""}</span></div>
      <div class="stat"><b>${shown(sum.total, cur)}</b><span>really spent${n > 1 && spentAny ? ` · ${shown(sum.total / n, cur)} each` : ""}</span><button type="button" class="link-btn" data-cx-go="spent">${spentAny ? "See all" : "Add what you paid"}</button></div>
      ${perDay ? `<div class="stat ${diff < 0 ? "over" : ""}"><b>${shown(Math.abs(diff), cur)}</b><span>${diff < 0 ? "over" : "under"} the budget of ${shown(budget, cur)} (${shown(perDay, cur)} a day)</span></div>` : ""}
      ${paidBookings ? `<div class="stat"><b>${shown(paidBookings, cur)}</b><span>bookings already paid (not in the estimate)</span></div>` : ""}
    </div>
    <div class="cx-cols">
      <div>
        <h3>Per day <span class="cx-legend"><i class="est"></i> estimate <i class="spent"></i> spent</span></h3>
        ${days.length ? `<table class="cb-table cx-days">${days.map((d, i) => {
          const e = Number(d.estimatedCost) || 0, s = sum.byDay[d.date] || 0;
          return `<tr data-cx-day="${i}" title="Open this day in the Plan tab"><td class="muted">${esc(fmtDate(d.date))}</td><td class="cx-town">${esc(d.city.split(",")[0])}</td>
            <td class="cx-bars">${bar(e, maxDay, "est")}${bar(s, maxDay, "spent")}</td>
            <td class="num${perDay && e > perDay ? " over" : ""}">${shown(e, cur)}</td><td class="num">${s ? shown(s, cur) : "—"}</td></tr>`;
        }).join("")}</table>` : `<p class="hint">No plan yet.</p>`}
      </div>
      <div>
        <h3>By kind <span class="cx-legend"><i class="est"></i> estimate <i class="spent"></i> spent</span></h3>
        ${kinds.length ? `<table class="cb-table">${kinds.map(([k, label]) => `<tr><td>${esc(label)}</td><td class="cx-bars">${bar(estKind[k] || 0, maxKind, "est")}${bar(sum.byKind[k] || 0, maxKind, "spent")}</td><td class="num">${shown(estKind[k] || 0, cur)}</td><td class="num">${sum.byKind[k] ? shown(sum.byKind[k], cur) : "—"}</td></tr>`).join("")}</table>` : `<p class="hint">Nothing with a cost yet.</p>`}
        <div class="fuel" data-fuel-box>${fuelHtml()}</div>
      </div>
    </div>
    <p class="hint">Estimates are the planner's, for the whole group${it?.localCurrency && it.localCurrency !== cur ? `, in ${esc(cur)} (prices there are in ${esc(it.localCurrency)})` : ""}; hotels aren't in them. Change them in the Plan tab.</p>
    ${days.length ? `<button class="btn" type="button" data-cb-csv>${icon("download")} Download the plan's costs as CSV</button>` : ""}`;
}

/** Every stop with a cost, for a spreadsheet. */
function csv() {
  const it = state.itinerary!, q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rowsOut = it.days.flatMap((d) => d.items.map((x) => { const e = linked(stopLink(d.date, x.place)); return [d.date, x.time, x.place, x.kind || "", splitGroup(x) || "", Number(x.cost) || 0, e ? amountText(inTrip(e, state.currency, fx) ?? undefined, state.currency) : "", e?.paidBy || ""]; }));
  return [["date", "time", "place", "kind", "group", `estimate (${state.currency})`, `paid (${state.currency})`, "paid by"], ...rowsOut].map((r) => r.map(q).join(",")).join("\n");
}

// ---- Plan -----------------------------------------------------------------------------------------------------------------
/** What a "paid" field next to something in the plan makes when filled in. */
interface Preset { what: string; date: string; kind: ReturnType<typeof kindOf> | "stay"; split?: string[]; est: number }
const presets = new Map<string, Preset>();
/** What's typed in the Plan tab's search (kept while the window is open). */
let planQuery = "";
/** "Paid by" for everyone paying their own share (tickets bought one by one). */
const EACH = "__each";

/** A quiet money field for a table row: the symbol inside, no spinner, empty for nothing. */
const moneyIn = (attrs: string, value: number | undefined, cur: string) =>
  `<span class="cx-in"><span class="cx-sym">${esc(currencySymbol(cur))}</span><input type="number" min="0" inputmode="decimal" step="${step(cur)}" ${attrs} placeholder=" " value="${esc(value ? amountText(value, cur) : "")}"${ro() ? " disabled" : ""}></span>`;

/** Who it was for, in a few words: "everyone", "3 of 4 · covers Tom", "each their own". */
export function splitWords(e: Expense, names: string[]) {
  if (e.each) return "each their own";
  const forN = e.split?.length && e.split.length < names.length ? `${e.split.length} of ${names.length}` : "everyone", cov = coveredBy(e, names), own = ownBy(e, names), back = backBy(e, names);
  const uneven = Object.keys(e.shares || {}).some((n) => (e.split?.length ? e.split : names).includes(n));
  return [forN, uneven ? "uneven" : "", cov.length ? `covers ${cov.join(", ")}` : "", own.length ? `${own.length} paid own` : "", back.length ? `${back.length} paid back` : ""].filter(Boolean).join(" · ");
}

/** Really paid (in its currency), who paid it (or each their own), and who it was for. */
function paidCells(link: string, p: Preset) {
  presets.set(link, p);
  const e = linked(link), cur = e?.currency || state.currency, names = people(), off = ro() ? " disabled" : "";
  const asEst = !e && p.est > 0 && !ro() ? `<button type="button" class="cx-asest" data-paid-est="${esc(link)}" title="Paid as estimated">${icon("check")} ${esc(shown(p.est, state.currency))}</button>` : "";
  const payer = e?.each ? EACH : e?.paidBy || "";
  return `<td class="cx-paid"><div class="cx-paid-in">${moneyIn(`data-paid="${esc(link)}" data-fk="paid:${esc(link)}" aria-label="Really paid"`, e?.amount, cur)}${asEst}</div></td>
    ${names.length > 1 ? `<td class="cx-payer"><select data-payer="${esc(link)}" data-fk="payer:${esc(link)}" aria-label="Paid by"${off}>${e ? "" : `<option value="">—</option>`}${names.map((n) => `<option value="${esc(n)}"${n === payer ? " selected" : ""}>${esc(n)}</option>`).join("")}<option value="${EACH}"${payer === EACH ? " selected" : ""}>Each paid their own</option></select></td>
      <td class="cx-split-cell">${e ? `<button type="button" class="cx-split-btn" data-split-pop="${esc(e.id)}" title="Who it was for, and whose share the payer covers"${off}>${icon("users")}<span>${esc(splitWords(e, names))}</span>${icon("chevronDown")}</button>` : ""}</td>` : ""}`;
}

function planHtml() {
  presets.clear();
  const it = state.itinerary, cur = state.currency, names = people(), split = names.length > 1;
  const sum = spending(rows(), names, cur, fx);
  const q = (...parts: string[]) => esc(fold(parts.join(" ")));
  const head = (first: string) => `<tr class="cx-th"><td class="cx-time">${first}</td><td class="cx-stop"></td><td class="cx-estc">Estimate</td><td class="cx-paid">Really paid</td>${split ? `<td class="cx-payer">Paid by</td><td class="cx-split-cell">For</td>` : ""}</tr>`;
  const days = (it?.days || []).map((d, di) => {
    const est = Number(d.estimatedCost) || 0, spent = sum.byDay[d.date] || 0;
    return `<section class="cx-pday" id="cx-day-${di}" data-q="${q(`day ${di + 1}`, fmtDate(d.date), d.date, d.city, d.title)}"><h3><span>Day ${di + 1} · ${esc(fmtDate(d.date))} · ${esc(d.city.split(",")[0])}</span><span class="hint">${esc(d.title)}</span><span class="num">est. ${shown(est, cur)}${spent ? ` · spent ${shown(spent, cur)}` : ""}</span></h3>
      <table class="cb-table cx-plan">${head("Time")}${d.items.map((x, xi) => {
        const who = (x.who || []).filter((n) => names.includes(n));
        return `<tr data-q="${q(x.place, x.where || "", x.time)}"><td class="muted cx-time">${esc(fmtTime(x.time))}</td><td class="cx-stop">${esc(x.place)}${splitGroup(x) ? ` <span class="muted">· ${esc(x.who?.join(", ") || x.group || "")}</span>` : ""}</td>
          <td class="cx-estc">${moneyIn(`class="cx-est" data-est="${di}-${xi}" data-fk="est:${di}-${xi}" aria-label="Estimate for the group"`, x.cost, cur)}</td>
          ${paidCells(stopLink(d.date, x.place), { what: x.place.split(",")[0], date: d.date, kind: kindOf(x.kind), est: Number(x.cost) || 0, ...(who.length ? { split: who } : {}) })}</tr>`;
      }).join("")}</table></section>`;
  }).join("");
  const stays = state.stays.filter((s) => s.city.trim() && s.start);
  const bookings = (state.bookings || []).filter((b) => b.name);
  return `${!split && (Number(state.travelers) || 1) > 1 ? `<p class="hint cx-tip">${icon("users")} Name the travelers (Who owes tab, or Travelers &amp; style) to say who paid what.</p>` : ""}
    ${days || `<p class="hint">No plan yet.</p>`}
    ${stays.length ? `<section class="cx-pday" data-q="${q("accommodation hotel stay")}"><h3><span>${icon("bed")} Accommodation</span><span class="hint">not in the plan's estimate</span></h3>
      <table class="cb-table cx-plan">${head("Nights")}${stays.map((s) => `<tr data-q="${q(s.hotel, s.city, s.start)}"><td class="muted cx-time">${Number(s.nights) || 0}</td><td class="cx-stop">${esc(s.hotel || `Stay in ${s.city.split(",")[0]}`)} <span class="muted">· ${esc(fmtDate(s.start))}</span></td><td class="muted">—</td>
        ${paidCells(stayLink(s.city, s.start), { what: s.hotel || `Stay in ${s.city.split(",")[0]}`, date: s.start, kind: "stay", est: 0 })}</tr>`).join("")}</table></section>` : ""}
    ${bookings.length ? `<section class="cx-pday" data-q="${q("bookings")}"><h3><span>${icon("ticket")} Bookings</span></h3>
      <table class="cb-table cx-plan">${head("Day")}${bookings.map((b, bi) => `<tr data-q="${q(b.name, b.date, b.where || "")}"><td class="muted cx-time">${esc(fmtDate(b.date))}</td><td class="cx-stop">${esc(b.name)} <span class="muted">· ${b.countCost ? "in the day's cost" : "already paid"}</span></td>
        <td class="cx-estc">${moneyIn(`class="cx-est" data-bk-cost="${bi}" data-fk="bk:${bi}" aria-label="Cost"`, b.cost, cur)}</td>
        ${paidCells(bookingLink(b.name, b.date), { what: b.name, date: b.date, kind: "sights", est: Number(b.cost) || 0 })}</tr>`).join("")}</table></section>` : ""}
    <p class="hint cx-noresult" hidden>Nothing in the plan matches “<span></span>”.</p>`;
}

/** Shows only the rows the search finds (by the stop, or its day: "day 3", a date, the town). */
function filterPlan(root: HTMLElement) {
  const words = fold(planQuery).split(/\s+/).filter(Boolean);
  let any = false;
  for (const sec of $$<HTMLElement>(".cx-pday", root)) {
    let some = false;
    for (const tr of $$<HTMLElement>("tr[data-q]", sec)) {
      const hay = `${sec.dataset.q} ${tr.dataset.q}`, hit = words.every((w) => hay.includes(w));
      tr.hidden = !hit; some ||= hit;
    }
    sec.hidden = !some; any ||= some;
  }
  const none = root.querySelector<HTMLElement>(".cx-noresult");
  if (none) { none.hidden = any || !words.length; none.querySelector("span")!.textContent = planQuery.trim(); }
}

/** The small window under a row's "For" button: who it was for, and whose share the payer covers. It stays open while
 *  ticking (each change is saved and the window drawn again behind it). */
/** Which row's window closed last, and when: a click on its own button just after closes it rather than opening it again
 *  (a press outside the window, the button included, has already closed it by then). */
let splitClosed = { id: "", at: 0 };

/** The row's button opens its window, and closes it again when it's open. */
function toggleSplit(anchor: HTMLElement, id: string) {
  const open = document.querySelector<HTMLElement>(".cx-pop");
  if (open?.dataset.id === id && open.matches(":popover-open")) { open.hidePopover(); return; }
  if (splitClosed.id === id && Date.now() - splitClosed.at < 400) return;
  openSplit(anchor, id);
}

function openSplit(anchor: HTMLElement, id: string) {
  document.querySelector(".cx-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "cx-pop";
  pop.dataset.id = id;
  pop.popover = "auto";
  $("#costsDialog").append(pop);
  const r = anchor.getBoundingClientRect();
  const below = innerHeight - r.bottom > 260;
  Object.assign(pop.style, { right: `${Math.max(8, innerWidth - r.right)}px`, ...(below ? { top: `${r.bottom + 6}px` } : { bottom: `${innerHeight - r.top + 6}px` }) });
  const render = () => {
    const e = state.expenses?.[id], names = people();
    if (!e) { pop.hidePopover(); return; }
    const who = e.split?.length ? e.split : names, v = Number(e.amount) || 0;
    const parts = partsOf(e, names), cov = coveredBy(e, names), own = ownBy(e, names), left = unassigned(e, names);
    const set = (n: string) => e.shares?.[n] != null && who.includes(n);
    const custom = who.some(set);
    const field = (n: string) => `<span class="cx-in cx-pop-in${set(n) ? " set" : ""}"><span class="cx-sym">${esc(currencySymbol(e.currency))}</span><input type="number" min="0" step="${step(e.currency)}" inputmode="decimal" data-pop-share="${esc(n)}" value="${set(n) ? esc(amountText(e.shares![n], e.currency)) : ""}" placeholder="${esc(amountText(parts[n], e.currency))}" aria-label="${esc(`What ${n} had`)}" title="What ${esc(n)} had: type it when it wasn't the same for everyone"${ro() ? " disabled" : ""}></span>`;
    pop.innerHTML = `<div class="cx-pop-head"><b>Who it was for</b><span class="hint">${esc(money(v, e.currency))} · ${custom ? "set per person" : "split evenly"}</span>${custom && !ro() ? `<button type="button" class="link-btn" data-pop-even>Split evenly</button>` : ""}</div>
      ${left ? `<p class="cx-pop-warn">${icon("warn")} The amounts come to ${esc(money(v - left, e.currency))}, not ${esc(money(v, e.currency))}: ${left > 0 ? `${esc(money(left, e.currency))} is nobody's yet` : `${esc(money(-left, e.currency))} too much`}. Until they add up, everyone's part is scaled to the total.</p>` : ""}
      ${names.map((n) => {
        const st = standOf(e, n, names), isFor = st !== "out", isPayer = st === "payer";
        const covers = isPayer ? cov.reduce((t, m) => t + (parts[m] || 0), 0) : 0;
        return `<div class="cx-pop-row${isFor ? " on" : ""} st-${st}">
          <label class="cx-pop-who"><input type="checkbox" data-pop-for="${esc(n)}"${who.includes(n) ? " checked" : ""}> <span>${esc(n)}</span>${isPayer ? ` <span class="cx-paid-badge">paid</span>` : ""}</label>
          ${isFor && !isPayer && !e.each && e.paidBy ? standPicker(n, st, `pop-${id}`) : isPayer && covers ? `<span class="hint cx-pop-covers">+ ${esc(money(covers, e.currency))} covered</span>` : "<span></span>"}
          <span class="cx-pop-amt">${who.includes(n) ? field(n) : ""}</span>
        </div>`;
      }).join("")}
      <p class="hint cx-pop-foot">${e.each ? "Each paid their own share: nobody owes anybody for this." : e.paidBy ? `${esc(e.paidBy)} paid ${esc(money(v - own.reduce((t, m) => t + (parts[m] || 0), 0), e.currency))}. Type someone's amount when it wasn't the same for everyone; the rest is split among the others. <b>Covered</b>: ${esc(e.paidBy)} takes their share. <b>Paid own</b>: they paid it themselves. <b>Paid back</b>: they already gave ${esc(e.paidBy)} their share.` : "Say who paid it first."}</p>`;
    const keepShares = (forWho: string[], shares: Record<string, number> | undefined) => {
      const kept = Object.fromEntries(Object.entries(shares || {}).filter(([n]) => forWho.includes(n)));
      return Object.keys(kept).length ? { shares: kept } : {};
    };
    const save = () => {
      const forWho = $$<HTMLInputElement>("[data-pop-for]", pop).filter((b) => b.checked).map((b) => b.dataset.popFor!);
      if (!forWho.length) { render(); return; }
      const { covered, own: ownNow, back } = readStands(pop, forWho, e.paidBy || "");
      const shares: Record<string, number> = { ...(e.shares || {}) };
      for (const i of $$<HTMLInputElement>("[data-pop-share]", pop)) { const n = i.dataset.popShare!; if (i.value === "") delete shares[n]; else shares[n] = Math.max(0, Number(i.value) || 0); }
      const { split: _s, covered: _c, own: _o, back: _b, shares: _sh, ...rest } = e;
      putExpense(id, { ...rest, ...(forWho.length < names.length ? { split: forWho } : {}), ...(covered.length ? { covered } : {}), ...(ownNow.length ? { own: ownNow } : {}), ...(back.length ? { back } : {}), ...keepShares(forWho, shares) });
      render();
    };
    for (const b of $$<HTMLInputElement>("input", pop)) b.onchange = save;
    // (Enter in an amount saves it without closing the popup.)
    for (const b of $$<HTMLInputElement>("[data-pop-share]", pop)) b.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); b.blur(); } };
    pop.querySelector<HTMLButtonElement>("[data-pop-even]")?.addEventListener("click", () => { const { shares: _sh, ...rest } = e; putExpense(id, rest); render(); });
  };
  render();
  pop.addEventListener("toggle", (ev) => { if ((ev as ToggleEvent).newState === "closed") { splitClosed = { id, at: Date.now() }; pop.remove(); } });
  pop.showPopover();
}

function wirePlan(root: HTMLElement) {
  const it = state.itinerary;
  filterPlan(root);
  for (const el of $$<HTMLInputElement>("[data-est]", root)) el.onchange = () => {
    const [di, xi] = el.dataset.est!.split("-").map(Number), d = it?.days[di], x = d?.items[xi];
    if (!d || !x) return;
    const v = el.value === "" ? undefined : Math.max(0, Number(el.value) || 0);
    if (v === undefined || v === 0) delete x.cost; else x.cost = v;
    // The day's total follows its stops, and the plan's total its days.
    d.estimatedCost = d.items.reduce((n, y) => n + (Number(y.cost) || 0), 0);
    it!.totalEstimatedCost = it!.days.reduce((n, y) => n + (Number(y.estimatedCost) || 0), 0);
    touched();
  };
  for (const el of $$<HTMLInputElement>("[data-bk-cost]", root)) el.onchange = () => {
    const b = state.bookings?.[+el.dataset.bkCost!];
    if (!b) return;
    const v = Number(el.value);
    if (el.value === "" || !(v > 0)) delete b.cost; else b.cost = v;
    touched();
  };
  /** Who's set as paying in a row before anything's paid (each their own, a name, or the last payer). */
  const payerOf = (link: string): { paidBy?: string; each?: true } => {
    if (people().length < 2) return {};
    const v = root.querySelector<HTMLSelectElement>(`[data-payer="${CSS.escape(link)}"]`)?.value || defaultPayer();
    return v === EACH ? { each: true } : v ? { paidBy: v } : {};
  };
  const make = (link: string, amount: number) => {
    const p = presets.get(link);
    if (!p) return;
    putExpense(null, { what: p.what, amount, currency: state.currency, date: p.date, kind: p.kind, link, ...payerOf(link), ...(p.split ? { split: p.split } : {}) });
  };
  for (const el of $$<HTMLInputElement>("[data-paid]", root)) el.onchange = () => {
    const link = el.dataset.paid!, e = linked(link), v = Number(el.value);
    if (el.value === "" || !(v > 0)) { if (e) dropExpense(e.id); return; }
    if (e) { const { id, ...rest } = e; putExpense(id, { ...rest, amount: v }); } else make(link, v);
  };
  for (const el of $$<HTMLButtonElement>("[data-paid-est]", root)) el.onclick = () => { const p = presets.get(el.dataset.paidEst!); if (p) make(el.dataset.paidEst!, p.est); };
  for (const el of $$<HTMLButtonElement>("[data-split-pop]", root)) el.onclick = () => toggleSplit(el, el.dataset.splitPop!);
  for (const el of $$<HTMLSelectElement>("[data-payer]", root)) el.onchange = () => {
    const e = linked(el.dataset.payer!);
    if (!e) { if (el.value && el.value !== EACH) last.paidBy = el.value; return; }
    const { id, paidBy: _p, each: _e, ...rest } = e;
    putExpense(id, { ...rest, ...(el.value === EACH ? { each: true } : el.value ? { paidBy: el.value } : {}) });
  };
}

// ---- The window -----------------------------------------------------------------------------------------------------------
const TABS: [CostsTab, string, Parameters<typeof icon>[0]][] = [["overview", "Overview", "wallet"], ["plan", "Plan", "list"], ["spent", "Expenses", "ticket"], ["owe", "Who owes", "users"]];

function draw(scrollTo?: string) {
  const body = $("#costsBody"), active = document.activeElement as HTMLElement | null;
  const fk = active && body.contains(active) ? active.dataset.fk : undefined, top = body.scrollTop;
  const cur = state.currency, sum = spending(rows(), people(), cur, fx), undo = takeUndo();
  const count: Partial<Record<CostsTab, string>> = { spent: sum.total ? shown(sum.total, cur) : "" };
  body.innerHTML = `<div class="cx-tabs" role="tablist">${TABS.map(([k, label, ic]) => `<button type="button" role="tab" class="cx-tab${k === tab ? " on" : ""}" data-cx-tab="${k}" aria-selected="${k === tab}">${icon(ic)} ${label}${count[k] ? `<span class="tb-count">${esc(count[k])}</span>` : ""}</button>`).join("")}${tab === "plan" ? `<label class="cx-search">${icon("search")}<input type="search" data-plan-q data-fk="planq" placeholder="Search stops, days, towns…" value="${esc(planQuery)}" aria-label="Search the plan"></label>` : ""}${displayPicker("data-cx-cur")}</div>
    ${undo ? `<div class="cx-undo">${esc(undo.text)}<button type="button" class="link-btn" data-cx-undo>Undo</button></div>` : ""}
    <div class="cx-pane cx-${tab}">${tab === "overview" ? overviewHtml() : tab === "plan" ? planHtml() : tab === "spent" ? spentHtml() : oweHtml()}</div>`;
  const pane = body.querySelector<HTMLElement>(".cx-pane")!;
  for (const b of $$<HTMLButtonElement>("[data-cx-tab]", body)) b.onclick = () => { tab = b.dataset.cxTab as CostsTab; clearUndo(); draw(); body.scrollTop = 0; };
  for (const b of $$<HTMLElement>("[data-cx-go]", body)) b.onclick = () => { tab = b.dataset.cxGo as CostsTab; draw(); body.scrollTop = 0; };
  body.querySelector<HTMLButtonElement>("[data-cx-undo]")?.addEventListener("click", () => takeUndo()?.undo());
  // Show prices in: the window and the plan behind it drawn again in that currency.
  const showCur = body.querySelector<HTMLButtonElement>("[data-cx-cur]");
  if (showCur) showCur.onclick = () => pickDisplayCurrency(showCur, () => { draw(); renderItinerary(); });
  if (tab === "overview") {
    body.querySelector<HTMLButtonElement>("[data-cb-csv]")?.addEventListener("click", () => downloadFile(new Blob([csv()], { type: "text/csv" }), "trip-costs.csv"));
    for (const r of $$<HTMLElement>("[data-cx-day]", body)) r.onclick = () => { tab = "plan"; draw(`cx-day-${r.dataset.cxDay}`); };
    // The fuel section redraws on its own (its inputs keep their place in the window).
    const fuel = pane.querySelector<HTMLElement>("[data-fuel-box]");
    if (fuel) { const redrawFuel = () => { fuel.innerHTML = fuelHtml(); wireFuel(fuel, redrawFuel); }; wireFuel(fuel, redrawFuel); loadFuelData().then((got) => { if (got && tab === "overview" && fuel.isConnected) redrawFuel(); }); }
  }
  if (tab === "plan") {
    wirePlan(pane);
    const search = body.querySelector<HTMLInputElement>("[data-plan-q]")!;
    search.oninput = () => { planQuery = search.value; filterPlan(pane); };
    // Esc empties the search (and leaves the window open).
    search.onkeydown = (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; planQuery = ""; filterPlan(pane); } };
  }
  if (tab === "spent") wireSpent(pane);
  if (tab === "owe") wireOwe(pane);
  meta();
  if (scrollTo) { body.querySelector(`#${scrollTo}`)?.scrollIntoView({ block: "start" }); return; }
  body.scrollTop = top;
  if (fk) body.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
  // A change in the form scrolls it into view (an expense picked to change).
  if (tab === "spent" && body.querySelector(".cx-form.editing")) body.querySelector(".cx-form")!.scrollIntoView({ block: "nearest" });
}

function meta() {
  const n = Number(state.travelers) || 1, days = state.itinerary?.days.length || 0;
  $("#costsMeta").textContent = [days ? `${days} days` : "", `${n} traveler${n > 1 ? "s" : ""}`, state.currency].filter(Boolean).join(" · ");
}

/** Opens the Costs window (at a tab: the expenses, say). */
export function openCosts(at?: CostsTab) {
  const dlg = $<HTMLDialogElement>("#costsDialog");
  if (at) tab = at;
  if (!dlg.open) { resetChanged(); editExpense(null); planQuery = ""; }
  setRedraw(() => { if (dlg.open) draw(); });
  setViewRedraw(() => draw());
  draw();
  // Rates for expenses in other currencies: drawn again when they first come in, but not over a form being filled in.
  const had = fxReady;
  loadFx().then((got) => { if (got && !had && dlg.open && !document.querySelector("#costsBody [data-ex-form]")) draw(); });
  dlg.onclose = () => { if (changed) renderItinerary(); };
  if (!dlg.open) dlg.showModal();
}
