// The Costs window's Expenses and Who owes tabs. Expenses: everything really paid, in any currency, who paid it and who
// it was for (the ones entered next to the plan's stops in the Plan tab are here too). Who owes: each traveler's share
// against what they paid, the fewest payments that even it out (each can be marked as paid), and per person what their
// share is made of.
import { type Expense, type ExpenseKind, KINDS, balances, costShares, coveredBy, type Expenses, decimals, inTrip, mergeFromPhone, ownBy, backBy, rateOf, settleUp, spending, standOf } from "../../../shared/expenses";
import { cleanNames } from "../../../shared/people";
import { $$, downloadFile, esc } from "../core/dom";
import { CURRENCIES, fmtDate, fmtTime, money, todayIso } from "../core/format";
import { type IconName, icon } from "../core/icons";
import { type PickItem, pickList } from "../core/pick-list";
import { state } from "../core/state";
import { showNames } from "../trip/fields";
import { type Row, amountText, defaultDate, defaultPayer, dropExpense, fx, kindOf, last, linked, needNames, people, putExpense, ro, rows, step, stopLink, touched, tripDates, readStands, standPicker, noteUndo } from "./costs-data";
import { PHONE_EXPENSES } from "../export/offline-extras";
import { tell } from "../core/ask";

const KIND_ICON: Record<ExpenseKind, IconName> = { food: "utensils", sights: "ticket", transport: "train", stay: "bed", shopping: "shoppingBag", other: "pin", settle: "check" };
/** "Paid by" for everyone paying their own share. */
const EACH = "__each";
const kindLabel = (k?: ExpenseKind) => (k === "settle" ? "Paid back" : KINDS.find(([x]) => x === k)?.[1] || "Other");
const opt = (v: string, text: string, sel: string) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(text)}</option>`;
/** "everyone", or the names. */
const forWhom = (e: Expense) => {
  const who = e.split?.length && people().length && e.split.length < people().length ? e.split.join(", ") : "everyone";
  const cov = coveredBy(e, people()), own = e.each ? [] : ownBy(e, people()), back = backBy(e, people());
  return [who, cov.length ? `${e.paidBy} covers ${cov.join(", ")}` : "", own.length ? `${own.join(", ")} paid their own` : "", back.length ? `${back.join(", ")} paid back` : ""].filter(Boolean).join(" · ");
};

/** The people whose share is unfolded on Who owes (kept while it's drawn again). */
const openShares = new Set<string>();
/** The currency's symbol ("€"), for inside a money field. */
const symbolOf = (cur: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((x) => x.type === "currency")?.value || cur; } catch { return cur; } };

/** The expense in the form (null: a new one). */
let editing: string | null = null;
/** The form is folded away until "Add an expense" (or an expense picked to change) opens it. */
let formOpen = false;
export const editExpense = (id: string | null) => { editing = id; formOpen = !!id; };

// ---- Names ----------------------------------------------------------------------------------------------------------------
/** Asked for when several travel but nobody's named: who paid and who owes need names. */
export const namesBox = () => ro() ? "" : `<form class="cx-names" data-names>
    <div>${icon("users")} <b>Who's traveling?</b> <span class="hint">Name the ${Number(state.travelers) || 2} of you to say who paid and to split costs (also under Travelers &amp; style).</span></div>
    <div class="cx-names-row"><input placeholder="e.g. Me, Anna, Ben" autocomplete="off"><button class="btn solid">Save names</button></div>
  </form>`;

export function wireNames(root: HTMLElement) {
  const f = root.querySelector<HTMLFormElement>("[data-names]");
  if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const list = cleanNames(f.querySelector("input")!.value);
    if (!list.length) return;
    state.people = list;
    if (list.length > (Number(state.travelers) || 1)) state.travelers = list.length;
    showNames();
    touched();
  };
}

// ---- Expenses -------------------------------------------------------------------------------------------------------------
/** A person's colour and initials for their avatar. */
const hue = (n: string) => [...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = (n: string) => n.split(/\s+/).map((w) => [...w][0] || "").join("").slice(0, 2).toUpperCase();
function formHtml() {
  const e = editing ? state.expenses?.[editing] : undefined, cur = state.currency;
  const curNow = e?.currency || last.currency || state.itinerary?.localCurrency || cur;
  const [a, b] = tripDates(), names = people();
  const curs = [...new Set([curNow, cur, state.itinerary?.localCurrency || "", ...CURRENCIES].filter(Boolean))];
  const who = e?.split?.length ? e.split : names;
  // A stop of the plan to fill in from (a searchable list, see wireSpent).
  const fromPlan = state.itinerary?.days.some((d) => d.items.length) ? `<div class="se-f cx-from"><span>From the plan <small>(fills in what, day and kind)</small></span><div data-from-pick></div></div>` : "";
  return `<form class="cx-form${e ? " editing" : ""}" data-ex-form>
    <div class="cx-form-title">${e ? `${icon("pencil")} Change “${esc(e.what)}”` : `${icon("plus")} Add an expense`}<button type="button" class="icon-btn" data-ex-fold title="Close">${icon("x")}</button></div>
    ${fromPlan ? `<div class="se-row">${fromPlan}</div>` : ""}
    <div class="cx-grid">
      <label class="se-f cx-what"><span>What</span><input data-x="what" value="${esc(e?.what || "")}" placeholder="e.g. Dinner at the night market" maxlength="120"></label>
      <div class="se-f cx-amount"><span>Full amount</span>
        <div class="cx-money-in"><input data-x="amount" type="number" min="0" inputmode="decimal" step="${step(curNow)}" value="${esc(amountText(e?.amount, curNow))}" placeholder="0" required aria-label="Full amount"><select data-x="currency" aria-label="Currency">${curs.map((c) => opt(c, c, curNow)).join("")}</select></div>
        <div class="cx-rate" data-rate-box ${curNow === cur ? "hidden" : ""}>1 <span data-rate-label>${esc(curNow)}</span> = <input data-x="rate" type="number" min="0" step="any" value="${esc(e?.rate && e.rateTo === cur ? e.rate : rateOf(curNow, cur, fx) || "")}" aria-label="Exchange rate"> ${esc(cur)} <b data-conv></b></div>
      </div>
      <label class="se-f"><span>Day</span><input data-x="date" type="date" value="${esc(e?.date || defaultDate())}"${a ? ` min="${esc(a)}"` : ""}${b ? ` max="${esc(b)}"` : ""}></label>
      <label class="se-f"><span>Kind</span><select data-x="kind">${KINDS.map(([k, t]) => opt(k, t, e?.kind || last.kind)).join("")}</select></label>
      ${names.length > 1 ? `<label class="se-f"><span>Paid by</span><select data-x="paidBy">${names.map((n) => opt(n, n, e?.each ? "" : e?.paidBy || defaultPayer())).join("")}${opt(EACH, "Each paid their own", e?.each ? EACH : "")}</select></label>` : ""}
    </div>
    ${names.length > 1 ? `<div class="cx-split">
      <div class="cx-split-head"><b>Split between</b><span class="hint" data-split-sum></span><span class="cx-split-links"><button type="button" class="link-btn" data-split-all>All</button><button type="button" class="link-btn" data-split-none>None</button></span></div>
      <div class="cx-people">${names.map((n) => `<div class="cx-person" data-person="${esc(n)}" style="--h:${hue(n)}">
        <label class="cx-who" title="${esc(`Was it for ${n}? Click to include or leave out`)}"><input type="checkbox" data-for="${esc(n)}"${who.includes(n) ? " checked" : ""}><span class="cx-avatar">${esc(initials(n))}${icon("check")}</span><span class="cx-name">${esc(n)}</span><span class="cx-paid-badge">paid</span></label>
        <span class="cx-part" data-part="${esc(n)}"></span>
        <span class="cx-payer-note" data-payer-note="${esc(n)}"></span>
        ${standPicker(n, e ? (st => (st === "payer" || st === "out" ? "owes" : st))(standOf(e, n, names)) : "owes", "form")}
      </div>`).join("")}</div>
    </div>` : ""}
    <div class="cx-form-foot">
      <p class="cx-error" data-ex-error hidden></p>
      <div class="cx-form-acts">${e ? `<button type="button" class="btn" data-ex-cancel>Cancel</button>` : ""}<button class="btn solid">${e ? "Save" : `${icon("plus")} Add expense`}</button></div>
    </div>
  </form>`;
}

function rowHtml(e: Row) {
  const cur = state.currency, v = inTrip(e, cur, fx), names = people().length > 1;
  return `<tr${editing === e.id ? ` class="editing"` : ""}>
    <td><b>${esc(e.what)}</b>${e.link ? ` <span class="cx-tag" title="Entered next to it in the Plan tab">${icon(e.link.startsWith("stay:") ? "bed" : e.link.startsWith("booking:") ? "ticket" : "pin")} plan</span>` : ""}<div class="hint">${esc(kindLabel(e.kind))}${names ? ` · ${e.kind === "settle" ? `${esc(e.paidBy || "?")} → ${esc(e.split?.[0] || "?")}` : e.each ? `each paid their own · for ${esc(forWhom(e))}` : `paid by ${esc(e.paidBy || "nobody said")} · for ${esc(forWhom(e))}`}` : ""}</div></td>
    <td class="num">${money(e.amount, e.currency)}${e.currency !== cur ? `<div class="hint">${v == null ? "no rate" : `≈ ${money(v, cur)}`}</div>` : ""}</td>
    <td class="cx-acts">${ro() ? "" : `${e.kind === "settle" ? "" : `<button type="button" class="icon-btn" data-ex-edit="${esc(e.id)}" title="Change">${icon("pencil")}</button>`}<button type="button" class="icon-btn" data-ex-del="${esc(e.id)}" title="Remove">${icon("x")}</button>`}</td>
  </tr>`;
}

export function spentHtml() {
  const cur = state.currency, all = rows(), days = state.itinerary?.days || [];
  const sum = spending(all, people(), cur, fx);
  const byDate = new Map<string, Row[]>();
  for (const e of all) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date)!.push(e); }
  const dayName = (date: string) => { const i = days.findIndex((d) => d.date === date); return i >= 0 ? `Day ${i + 1} · ${days[i].city.split(",")[0]}` : ""; };
  return `${needNames() ? namesBox() : ""}
    ${ro() ? "" : formOpen ? formHtml() : `<button type="button" class="cx-add" data-ex-open>${icon("plus")} Add an expense</button>`}
    <div class="stats cb-stats">
      <div class="stat"><b>${money(sum.total, cur)}</b><span>spent in all${sum.unrated ? ` (${sum.unrated} without an exchange rate not counted)` : ""}</span></div>
      <div class="stat"><b>${all.filter((e) => e.kind !== "settle").length}</b><span>expenses</span></div>
    </div>
    ${all.length ? [...byDate].map(([date, list]) => {
      const dayTotal = list.filter((e) => e.kind !== "settle").reduce((n, e) => n + (inTrip(e, cur, fx) || 0), 0);
      return `<h3 class="cx-day"><span>${esc(fmtDate(date) || date)}</span><span class="hint">${esc(dayName(date))}</span><span class="num">${dayTotal ? money(dayTotal, cur) : ""}</span></h3>
        <table class="cb-table cx-list">${list.map(rowHtml).join("")}</table>`;
    }).join("") : `<p class="hint cx-empty">Nothing yet. Add what you paid above, or next to the stops in the Plan tab.</p>`}
    <div class="cx-tools">
      ${ro() ? "" : `<label class="btn" title="Expenses entered in the phone file during the trip (its “Send to the app”)">${icon("upload")} Import from phone<input type="file" accept=".json,application/json" data-ex-import hidden></label>`}
      ${all.length ? `<button class="btn" type="button" data-ex-csv>${icon("download")} Download as CSV</button>` : ""}
    </div>`;
}

/** Expenses sent from the phone file: the new ones added (by id, so the same file twice adds nothing twice). */
async function importFromPhone(file: File) {
  let data: { kind?: string; expenses?: unknown; base?: Expenses };
  try { data = JSON.parse(await file.text()); } catch { data = {}; }
  if (data?.kind !== PHONE_EXPENSES || !data.expenses) { await tell({ title: "Not expenses from the phone", text: "Choose the file the phone file saves with “Send to the app”." }); return; }
  const before = state.expenses;
  // What was added, changed or removed on the phone since its file was made; the app's own later changes stay.
  const m = mergeFromPhone(data.base && typeof data.base === "object" ? data.base : undefined, state.expenses, data.expenses);
  const words = [m.added ? `${m.added} added` : "", m.changed ? `${m.changed} changed` : "", m.removed ? `${m.removed} removed` : ""].filter(Boolean);
  if (!words.length) { await tell({ title: "Nothing new", text: m.clashes ? `${m.clashes} expense${m.clashes === 1 ? " was" : "s were"} changed both here and on the phone: the ones here were kept.` : "Everything in that file is here already." }); return; }
  state.expenses = Object.keys(m.expenses).length ? m.expenses : undefined;
  noteUndo(`From the phone: ${words.join(", ")}${m.clashes ? ` (${m.clashes} changed both here and there: kept as here)` : ""}`, () => { state.expenses = before; });
  touched();
}

function csv() {
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`, cur = state.currency;
  const out = rows().map((e) => [e.date, e.what, kindLabel(e.kind), e.amount, e.currency, amountText(inTrip(e, cur, fx) ?? undefined, cur), e.paidBy || "", e.kind === "settle" ? e.split?.[0] || "" : forWhom(e)]);
  return [["date", "what", "kind", "amount", "currency", `in ${cur}`, "paid by", "for"], ...out].map((r) => r.map(q).join(",")).join("\n");
}

export function wireSpent(root: HTMLElement) {
  wireNames(root);
  root.querySelector<HTMLButtonElement>("[data-ex-csv]")?.addEventListener("click", () => downloadFile(new Blob([csv()], { type: "text/csv" }), "trip-expenses.csv"));
  const pick = root.querySelector<HTMLInputElement>("[data-ex-import]");
  if (pick) pick.onchange = () => { const f = pick.files?.[0]; pick.value = ""; if (f) importFromPhone(f); };
  for (const b of $$<HTMLButtonElement>("[data-ex-del]", root)) b.onclick = () => { if (editing === b.dataset.exDel) editing = null; dropExpense(b.dataset.exDel!); };
  for (const b of $$<HTMLButtonElement>("[data-ex-edit]", root)) b.onclick = () => { editing = b.dataset.exEdit!; formOpen = true; touchedView(root); };
  root.querySelector<HTMLButtonElement>("[data-ex-open]")?.addEventListener("click", () => { formOpen = true; touchedView(root); root.querySelector<HTMLInputElement>("[data-from-pick] input, [data-x=what]")?.focus(); });
  const form = root.querySelector<HTMLFormElement>("[data-ex-form]");
  if (!form) return;
  form.querySelector<HTMLButtonElement>("[data-ex-fold]")!.onclick = () => { editing = null; formOpen = false; touchedView(root); };
  const f = <T extends HTMLElement = HTMLInputElement>(k: string) => form.querySelector<T>(`[data-x="${k}"]`)!;
  const cur = state.currency;
  // The rate shows for another currency than the trip's, with what the amount comes to.
  const conv = () => {
    const c = f<HTMLSelectElement>("currency").value, amount = Number(f("amount").value), rate = Number(f("rate").value);
    form.querySelector<HTMLElement>("[data-conv]")!.textContent = c !== cur && amount > 0 && rate > 0 ? `≈ ${money(amount * rate, cur)}` : "";
  };
  f<HTMLSelectElement>("currency").onchange = () => {
    const c = f<HTMLSelectElement>("currency").value;
    form.querySelector<HTMLElement>("[data-rate-box]")!.hidden = c === cur;
    form.querySelector<HTMLElement>("[data-rate-label]")!.textContent = c;
    f("rate").value = String(rateOf(c, cur, fx) || "");
    f("amount").step = step(c);
    conv();
  };
  f("amount").oninput = () => { conv(); parts(); }; f("rate").oninput = conv;
  conv();
  // Who it was for: "covered" only for those it was for (not the payer), and each one's part as they type.
  const boxes = (sel: string) => $$<HTMLInputElement>(sel, form);
  const parts = () => {
    if (people().length < 2) return;
    const payer = f<HTMLSelectElement>("paidBy").value, amount = Number(f("amount").value) || 0, c = f<HTMLSelectElement>("currency").value;
    const forWho = boxes("[data-for]").filter((b) => b.checked).map((b) => b.dataset.for!);
    const each = payer === EACH;
    form.classList.toggle("each", each);
    const { covered, own, back } = each ? { covered: [], own: [], back: [] } : readStands(form, forWho, payer);
    const share = forWho.length ? amount / forWho.length : 0;
    for (const el of $$<HTMLElement>("[data-person]", form)) {
      const n = el.dataset.person!, isFor = forWho.includes(n), cov = covered.includes(n), paid = n === payer;
      const mineOwn = own.includes(n), mineBack = back.includes(n);
      el.classList.toggle("on", isFor); el.classList.toggle("payer", paid); el.classList.toggle("covered", cov); el.classList.toggle("own", mineOwn || mineBack);
      for (const l of $$<HTMLElement>(".cx-seg label", el)) l.classList.toggle("on", !!l.querySelector<HTMLInputElement>("input")?.checked);
      // The payer's own part: their share, and the shares they cover.
      const mine = (isFor ? share : 0) + share * covered.length;
      const part = el.querySelector<HTMLElement>("[data-part]")!;
      // What the payer really paid: the full amount, less the shares others paid themselves.
      const paidSum = amount - share * own.length;
      const backNote = back.length && amount ? ` · ${money(share * back.length, c)} paid back` : "";
      el.querySelector<HTMLElement>("[data-payer-note]")!.textContent = paid ? (amount ? (own.length ? `Paid ${money(paidSum, c)} of ${money(amount, c)}` : `Paid the full ${money(amount, c)}`) + backNote : "Pays the full amount") : "";
      part.innerHTML = !isFor && !paid ? `<span class="hint">not in it</span>`
        : each ? (amount ? `<b>${esc(money(share, c))}</b><small>paid their own</small>` : `<small>pays their own</small>`)
        : paid ? (amount ? `<b>${esc(money(mine, c))}</b><small>own part${covered.length ? `, covers ${covered.length}` : ""}</small>` : "")
          : cov ? (amount ? `<b>${esc(money(share, c))}</b><small>covered</small>` : `<small>covered</small>`)
            : mineOwn ? (amount ? `<b>${esc(money(share, c))}</b><small>paid their own</small>` : `<small>pays their own</small>`)
            : mineBack ? (amount ? `<b>${esc(money(share, c))}</b><small>paid ${esc(payer)} back</small>` : `<small>paid back</small>`)
            : amount ? `<b>${esc(money(share, c))}</b><small>owes ${esc(payer)}</small>` : "";
    }
    const sum = form.querySelector<HTMLElement>("[data-split-sum]");
    if (sum) sum.textContent = !forWho.length ? "nobody yet" : each ? `each pays their own${amount ? ` · ${money(share, c)} each` : ""}` : amount ? `${money(share, c)} each for ${forWho.length}${covered.length ? ` · ${payer} covers ${covered.length}` : ""}${own.length ? ` · ${own.length} paid their own` : ""}${back.length ? ` · ${back.length} paid back` : ""}` : `${forWho.length} of ${people().length}`;
  };
  const setAll = (on: boolean) => { for (const b of boxes("[data-for]")) b.checked = on; parts(); };
  form.querySelector("[data-split-all]")?.addEventListener("click", () => setAll(true));
  form.querySelector("[data-split-none]")?.addEventListener("click", () => setAll(false));
  for (const b of boxes("[data-for], [data-stand]")) b.addEventListener("change", parts);
  form.querySelector<HTMLSelectElement>('[data-x="paidBy"]')?.addEventListener("change", parts);
  parts();
  // A stop picked from the plan fills in what, the day and the kind (and who it was for, on a split day); its estimate
  // shows in the amount until one is typed.
  const stopOf = (v: string) => { const [di, xi] = v.split("-").map(Number), d = state.itinerary?.days[di]; return d && d.items[xi] ? { d, x: d.items[xi] } : null; };
  const days = state.itinerary?.days || [], was0 = editing ? state.expenses?.[editing] : undefined;
  const items: PickItem[] = days.flatMap((d, di) => d.items.map((x, xi) => {
    const paid = linked(stopLink(d.date, x.place));
    return {
      value: `${di}-${xi}`, label: x.place.split(",")[0], group: `Day ${di + 1} · ${fmtDate(d.date) || d.date} · ${d.city.split(",")[0]}`,
      lead: fmtTime(x.time), icon: KIND_ICON[kindOf(x.kind)], note: x.cost ? money(Number(x.cost), cur) : "",
      tag: paid && paid.id !== editing ? "paid" : "", words: `${x.place} ${x.where || ""} ${d.date} ${d.title}`,
    };
  }));
  const pickHost = form.querySelector<HTMLElement>("[data-from-pick]");
  const from = pickHost ? pickList(pickHost, {
    items, placeholder: "Search the plan's stops by name, day or town…", empty: "No stop in the plan matches",
    value: items.find((it) => { const s = stopOf(it.value); return s && was0?.link === stopLink(s.d.date, s.x.place); })?.value,
    onPick: () => fill(),
  }) : null;
  const fill = () => {
    const s = from ? stopOf(from.value()) : null;
    f("amount").placeholder = s?.x.cost ? amountText(Number(s.x.cost), cur) : "";
    if (!s) return;
    f("what").value = s.x.place.split(",")[0];
    f("date").value = s.d.date;
    f<HTMLSelectElement>("kind").value = kindOf(s.x.kind);
    const who = (s.x.who || []).filter((n) => people().includes(n));
    for (const b of $$<HTMLInputElement>("[data-for]", form)) b.checked = !who.length || who.includes(b.dataset.for!);
    parts();
    f("amount").focus();
  };
  form.querySelector<HTMLButtonElement>("[data-ex-cancel]")?.addEventListener("click", () => { editing = null; formOpen = false; touchedView(root); });
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const err = form.querySelector<HTMLElement>("[data-ex-error]")!;
    const say = (t: string) => { err.textContent = t; err.hidden = false; };
    const amount = Number(f("amount").value), c = f<HTMLSelectElement>("currency").value, rate = Number(f("rate").value);
    if (!(amount > 0)) { f("amount").focus(); return say("How much was it?"); }
    if (c !== cur && !(rate > 0)) { f("rate").focus(); return say(`There's no exchange rate for ${c} yet: type what 1 ${c} is in ${cur}.`); }
    const kind = f<HTMLSelectElement>("kind").value as ExpenseKind;
    const ticked = $$<HTMLInputElement>("[data-for]", form).filter((b) => b.checked).map((b) => b.dataset.for!);
    if (people().length > 1 && !ticked.length) return say("Tick at least one person it was for.");
    const picked = people().length > 1 ? f<HTMLSelectElement>("paidBy").value : "", each = picked === EACH, payer = each ? "" : picked;
    const { covered, own, back } = each ? { covered: [], own: [], back: [] } : readStands(form, ticked, payer);
    const was = editing ? state.expenses?.[editing] : undefined;
    // Picked from the plan: it's that stop's payment (shown next to it in the Plan tab), unless the stop has one already.
    // Nothing picked: a stay's or booking's link stays, a stop's goes.
    const s = from?.value() ? stopOf(from.value()) : null, at = s ? stopLink(s.d.date, s.x.place) : "";
    const taken = at ? linked(at) : undefined;
    const link = s ? (!taken || taken.id === editing ? at : undefined) : was?.link && !was.link.startsWith("stop:") ? was.link : undefined;
    const e: Expense = {
      what: f("what").value.trim() || kindLabel(kind), amount, currency: c, date: f("date").value || todayIso(), kind,
      ...(c !== cur ? { rate, rateTo: cur } : {}),
      ...(each ? { each: true as const } : payer ? { paidBy: payer } : {}),
      ...(ticked.length && ticked.length < people().length ? { split: ticked } : {}),
      ...(covered.length ? { covered } : {}),
      ...(own.length ? { own } : {}),
      ...(back.length ? { back } : {}),
      ...(link ? { link } : {}), ...(was?.at ? { at: was.at } : {}),
    };
    putExpense(editing, e);
    editing = null;
  };
}

/** Draws again without a change to the trip (switching what the form shows). */
let viewRedraw: (root: HTMLElement) => void = () => {};
export const setViewRedraw = (f: (root: HTMLElement) => void) => { viewRedraw = f; };
const touchedView = (root: HTMLElement) => viewRedraw(root);

// ---- Who owes -------------------------------------------------------------------------------------------------------------
export function oweHtml() {
  if (needNames()) return namesBox();
  const names = people(), cur = state.currency;
  if (names.length < 2) return `<p class="hint cx-empty">With one traveler there's nothing to split. Name more travelers under Travelers &amp; style to share costs.</p>`;
  const all = rows(), spent = all.filter((e) => e.kind !== "settle"), settles = all.filter((e) => e.kind === "settle");
  const sum = spending(all, names, cur, fx), bal = balances(all, names, cur, fx), pay = settleUp(bal, cur);
  // What each really paid out: as the payer, all but the shares others paid themselves; their own share when they paid it.
  const paid = (n: string) => spent.reduce((s, e) => {
    const v = inTrip(e, cur, fx) || 0, who = e.split?.length ? e.split : names, share = who.length ? v / who.length : 0, own = [...ownBy(e, names), ...backBy(e, names)];
    return s + (!e.each && e.paidBy === n ? v - share * own.length : 0) + (own.includes(n) ? share : 0);
  }, 0);
  const back = (n: string) => settles.reduce((s, e) => s + (e.paidBy === n ? 1 : e.split?.[0] === n ? -1 : 0) * (inTrip(e, cur, fx) || 0), 0);
  const everyone = [...new Set([...names, ...Object.keys(bal)])];
  const noPayer = spent.filter((e) => !e.each && (!e.paidBy || !names.includes(e.paidBy)));
  return `<div class="stats cb-stats">
      <div class="stat"><b>${money(sum.total, cur)}</b><span>spent in all</span></div>
      <div class="stat"><b>${money(sum.total / names.length, cur)}</b><span>on average per person</span></div>
      <div class="stat ${pay.length ? "over" : ""}"><b>${pay.length ? money(pay.reduce((s, p) => s + p.amount, 0), cur) : "Even"}</b><span>${pay.length ? `still to pay back, in ${pay.length} payment${pay.length === 1 ? "" : "s"}` : "nobody owes anybody"}</span></div>
    </div>
    ${noPayer.length ? `<p class="cx-error">${noPayer.length} expense${noPayer.length === 1 ? " has" : "s have"} nobody set as having paid, so ${noPayer.length === 1 ? "it isn't" : "they aren't"} in the balances: ${esc(noPayer.slice(0, 4).map((e) => e.what).join(", "))}${noPayer.length > 4 ? "…" : ""}.</p>` : ""}
    <h3>Settle up</h3>
    ${pay.length ? `<ul class="cx-pay">${pay.map((p, i) => `<li><b>${esc(p.from)}</b> ${"→"} <b>${esc(p.to)}</b>${ro() ? `<span class="num">${money(p.amount, cur)}</span>` : `<span class="cx-pay-part hint" data-part-of="${i}" hidden>part of ${esc(money(p.amount, cur))}</span>
        <label class="cx-pay-amt" title="Paid only part of it? Change the amount: the rest stays open"><span>${esc(symbolOf(cur))}</span><input type="number" min="0" step="${step(cur)}" inputmode="decimal" data-settle-amt="${i}" value="${esc(p.amount.toFixed(decimals(cur)))}" aria-label="Amount paid"></label>
        <button type="button" class="btn" data-settle="${i}" title="Note it as paid: the balances even out by this much">${icon("check")} Mark as paid</button>`}</li>`).join("")}</ul>`
      : `<p class="hint">Everyone is even.</p>`}
    <h3>Balances</h3>
    <table class="cb-table cx-bal"><tr class="cx-th"><td>Who</td><td class="num">Paid</td><td class="num">Their share</td><td class="num">Paid back</td><td class="num">Balance</td></tr>
      ${everyone.map((n) => { const b = bal[n] || 0, tiny = Math.abs(b) < 0.005; return `<tr${names.includes(n) ? "" : ` class="muted" title="Not among the travelers anymore (renamed?)"`}><td><b>${esc(n)}</b></td><td class="num">${money(paid(n), cur)}</td><td class="num">${money(sum.share[n] || 0, cur)}</td><td class="num">${back(n) ? money(back(n), cur) : "—"}</td><td class="num ${tiny ? "" : b > 0 ? "cx-plus" : "cx-minus"}">${tiny ? "even" : `${b > 0 ? "gets back" : "owes"} ${money(Math.abs(b), cur)}`}</td></tr>`; }).join("")}
    </table>
    <h3>Each person's share</h3>
    ${names.map((n) => {
      // Their part of each expense they're in: their even share, plus the shares they covered, or nothing when covered.
      const mine = spent.map((e) => { const v = inTrip(e, cur, fx) || 0; return { e, v, part: costShares(e, v, names)[n] }; }).filter((x) => x.part !== undefined);
      return `<details class="cb-day cx-share" data-share="${esc(n)}"${openShares.has(n) ? " open" : ""}><summary><span class="cb-date"><b>${esc(n)}</b></span><span class="cb-city hint">${mine.length} expense${mine.length === 1 ? "" : "s"}</span><span></span><span class="num">${money(sum.share[n] || 0, cur)}</span></summary>
        <table class="cb-table">${mine.map(({ e, v, part }) => {
          const k = (e.split?.length ? e.split : names).length, cov = coveredBy(e, names);
          const why = ownBy(e, names).includes(n) ? "paid their own" : backBy(e, names).includes(n) ? `paid ${esc(e.paidBy!)} back` : cov.includes(n) ? `covered by ${esc(e.paidBy!)}` : e.paidBy === n && cov.length ? `paid it · covers ${esc(cov.join(", "))}` : e.paidBy === n ? "paid it" : e.paidBy ? `${esc(e.paidBy)} paid` : "";
          const st = standOf(e, n, names), id = (e as Row).id;
          const act = ro() ? "" : st === "owes" && e.paidBy ? `<button type="button" class="link-btn" data-back="${esc(id)}" data-who="${esc(n)}" title="${esc(`${n} already paid ${e.paidBy} back for this`)}">${icon("check")} Paid back</button>`
            : st === "back" ? `<button type="button" class="link-btn muted" data-unback="${esc(id)}" data-who="${esc(n)}" title="Not paid back after all">Undo</button>` : "";
          return `<tr${st === "back" ? ` class="cx-done"` : ""}><td class="muted">${esc(fmtDate(e.date))}</td><td>${esc(e.what)}${k > 1 ? ` <span class="muted">· ${money(v, cur)} for ${k}</span>` : ""}</td><td class="muted">${why}</td><td class="num">${cov.includes(n) ? "—" : money(part!, cur)}</td><td class="cx-share-act">${act}</td></tr>`;
        }).join("")}</table>
      </details>`;
    }).join("")}
    ${settles.length ? `<h3>Paid back</h3><table class="cb-table cx-list">${settles.map(rowHtml).join("")}</table>` : ""}`;
}

export function wireOwe(root: HTMLElement) {
  wireNames(root);
  const cur = state.currency, pay = settleUp(balances(rows(), people(), cur, fx), cur);
  for (const b of $$<HTMLButtonElement>("[data-settle]", root)) b.onclick = () => {
    const i = +b.dataset.settle!, p = pay[i], typed = Number(root.querySelector<HTMLInputElement>(`[data-settle-amt="${i}"]`)?.value);
    if (!p) return;
    // Part of it (a first installment), or all of it; never more than what's owed.
    const amount = typed > 0 ? Math.min(typed, p.amount) : p.amount, part = amount < p.amount;
    putExpense(null, { what: `${p.from} paid ${p.to} back${part ? " (part)" : ""}`, amount, currency: cur, date: todayIso(), paidBy: p.from, split: [p.to], kind: "settle" });
  };
  for (const el of $$<HTMLInputElement>("[data-settle-amt]", root)) el.oninput = () => {
    const p = pay[+el.dataset.settleAmt!], v = Number(el.value);
    root.querySelector<HTMLElement>(`[data-part-of="${el.dataset.settleAmt}"]`)!.hidden = !(p && v > 0 && v < p.amount);
  };
  // Open shares stay open.
  for (const d of $$<HTMLDetailsElement>("[data-share]", root)) d.ontoggle = () => { if (d.open) openShares.add(d.dataset.share!); else openShares.delete(d.dataset.share!); };
  // One thing ticked off as paid back (or not after all).
  const setBack = (id: string, n: string, on: boolean) => {
    const e = state.expenses?.[id];
    if (!e) return;
    const without = (l?: string[]) => (l || []).filter((x) => x !== n);
    const back = on ? [...without(e.back), n] : without(e.back), covered = without(e.covered), own = without(e.own);
    const { back: _b, covered: _c, own: _o, ...rest } = e;
    putExpense(id, { ...rest, ...(covered.length ? { covered } : {}), ...(own.length ? { own } : {}), ...(back.length ? { back } : {}) });
  };
  for (const b of $$<HTMLButtonElement>("[data-back]", root)) b.onclick = () => setBack(b.dataset.back!, b.dataset.who!, true);
  for (const b of $$<HTMLButtonElement>("[data-unback]", root)) b.onclick = () => setBack(b.dataset.unback!, b.dataset.who!, false);
  for (const b of $$<HTMLButtonElement>("[data-ex-del]", root)) b.onclick = () => dropExpense(b.dataset.exDel!);
}
