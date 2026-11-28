// The Journal (from the itinerary's toolbar): what you really did each day, in a few loose lines (written here, or in
// the phone file during the trip and brought in with Import from phone), and "Work out the day": the selected model
// reads the entry against what was planned and writes the day as it really went (server/trip/journal.ts), with the
// expenses it mentions for you to add to Costs. The plan stays as it was; the itinerary's Planned / Actual switch
// shows either. Days without an entry stay as planned.
import type { Day } from "../../../shared/types";
import { type ActualDay, type FoundExpense, actualDays, mergeJournal } from "../../../shared/journal";
import { type Expense, expenseId, mergeFromPhone } from "../../../shared/expenses";
import { closeOnBackdrop, esc, toast } from "../core/dom";
import { dayColor, fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { streamRequest } from "../core/progress";
import { save, session, state } from "../core/state";
import { askConfirm, tell } from "../core/ask";
import { isReadOnly } from "../saves/read-only";
import { PHONE_EXPENSES } from "../export/offline-extras";
import { cleanNames } from "../../../shared/people";
import { shown } from "./costs-data";

let dlg: HTMLDialogElement | null = null, redraw: () => void = () => {};
/** The days being worked out now (by date), with what the model is doing. */
const busy = new Map<string, { status: string; abort: AbortController }>();
/** Tells the itinerary to draw itself again (handed in: render.ts imports this file). */
export const setJournalRedraw = (fn: () => void) => { redraw = fn; };

/** The model that reads the journal: the trip chat's when one is picked, else the planning model. */
const model = () => state.chatModel || state.model;
/** That model as the Model menu names it. */
const modelName = () => [...(document.querySelector<HTMLSelectElement>("#model")?.options || [])].find((o) => o.value === model())?.textContent?.trim() || model() || "none picked";
const days = () => state.itinerary?.days || [];
const entry = (date: string) => state.journal?.[date];
/** A day's entry was changed after its actual day was worked out. */
const stale = (date: string) => { const a = state.actual?.[date], e = entry(date); return !!a && !!e && a.from !== e.at; };

export const hasActual = () => Object.keys(state.actual || {}).length > 0;
export const journalCount = () => Object.values(state.journal || {}).filter((e) => e.text.trim()).length;

function setEntry(date: string, text: string) {
  const journal = { ...(state.journal || {}) };
  if (text.trim() || journal[date]?.done?.length) journal[date] = { ...journal[date], text, at: Date.now() };
  else delete journal[date];
  state.journal = Object.keys(journal).length ? journal : undefined;
  save();
}

async function workOut(d: Day) {
  const e = entry(d.date);
  if (!e?.text.trim() || busy.has(d.date)) return;
  const abort = new AbortController();
  busy.set(d.date, { status: "Starting…", abort });
  draw();
  try {
    const { day } = await streamRequest<{ day: ActualDay }>("/api/journal", {
      model: model(), date: d.date, text: e.text, at: e.at, planned: d, done: e.done || [], people: state.people || [], currency: state.currency,
      localCurrency: state.itinerary?.localCurrency || state.currency, city: d.city,
    }, (l) => { const b = busy.get(d.date); if (b) { b.status = `${l.status}${l.seconds ? ` · ${l.seconds}s` : ""}`; const el = dlg?.querySelector(`[data-jr-status="${d.date}"]`); if (el) el.textContent = b.status; } }, abort.signal);
    state.actual = { ...(state.actual || {}), [d.date]: day };
    save();
  } catch (err) {
    if ((err as Error).name !== "AbortError") toast(`Couldn't work out ${fmtDate(d.date)}: ${(err as Error).message}`);
  } finally {
    busy.delete(d.date);
    draw(); redraw();
  }
}

/** The expenses a day's entry mentioned, into Costs (once). */
function addExpenses(date: string) {
  const a = state.actual?.[date];
  if (!a?.expenses?.length || a.added) return;
  const expenses = { ...(state.expenses || {}) }, now = Date.now();
  a.expenses.forEach((f: FoundExpense, i) => {
    const e: Expense = { what: f.what, amount: f.amount, currency: f.currency, date, kind: f.kind || "other", at: now + i, ...(f.paidBy ? { paidBy: f.paidBy } : {}), ...(f.split?.length ? { split: f.split } : {}) };
    expenses[expenseId(now + i)] = e;
  });
  state.expenses = expenses;
  state.actual = { ...state.actual, [date]: { ...a, added: true } };
  save();
  toast(`${a.expenses.length} expense${a.expenses.length === 1 ? "" : "s"} added to Costs`);
  draw(); redraw();
}

/** The travelers' names given in the phone file, for a trip that has none yet (its expenses say who paid by name). */
export function takePhoneNames(people: unknown): boolean {
  if (state.people?.length || !Array.isArray(people)) return false;
  const names = cleanNames(people.filter((n): n is string => typeof n === "string").join(", "));
  if (names.length < 2) return false;
  state.people = names;
  if (names.length > state.travelers) state.travelers = names.length;
  return true;
}

/** The file the phone file sends ("Send to the app"): its journal entries, and its expenses as Costs imports them. */
async function importPhone(file: File) {
  let data: { kind?: string; journal?: unknown; expenses?: unknown; base?: unknown; people?: unknown };
  try { data = JSON.parse(await file.text()); } catch { data = {}; }
  if (data?.kind !== PHONE_EXPENSES) { await tell({ title: "Not a file from the phone", text: "Choose the file the phone file saves with “Send”." }); return; }
  const j = mergeJournal(state.journal, data.journal);
  const m = data.expenses ? mergeFromPhone(data.base && typeof data.base === "object" ? (data.base as never) : undefined, state.expenses, data.expenses) : null;
  const money = m ? m.added + m.changed + m.removed : 0;
  const named = takePhoneNames(data.people);
  if (!j.taken && !money && !named) { await tell({ title: "Nothing new", text: "Everything in that file is here already." }); return; }
  if (j.taken) state.journal = j.journal;
  if (m && money) state.expenses = Object.keys(m.expenses).length ? m.expenses : undefined;
  save();
  toast([j.taken ? `${j.taken} journal entr${j.taken === 1 ? "y" : "ies"}` : "", money ? `${money} expense change${money === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") + " from the phone");
  draw(); redraw();
}

/** One stop of a day as it went. */
const stopRow = (x: Day["items"][number], cur: string, kept = false) => `<li${kept ? ' class="kept"' : ""}><span class="jr-time">${esc(x.time || "")}</span><div><b>${esc(x.place)}</b>${kept ? ` <span class="jr-kept">as planned</span>` : ""}${x.who?.length ? ` <span class="hint">${esc(x.who.join(", "))}</span>` : ""}
  ${x.description ? `<div>${esc(x.description)}</div>` : ""}${x.transport ? `<div class="hint">${esc(x.transport)}</div>` : ""}</div>${x.cost ? `<span class="jr-cost">${esc(shown(x.cost, cur))}</span>` : ""}</li>`;

function actualBlock(a: ActualDay, date: string, ro: boolean) {
  const cur = state.currency;
  const ex = a.expenses || [];
  return `<div class="jr-actual">
    <div class="jr-actual-head"><b>${icon("check")} ${esc(a.title)}</b>${stale(date) ? `<span class="jr-stale">${icon("warn")} the entry changed since: work it out again</span>` : ""}</div>
    ${a.notes ? `<p class="hint">${esc(a.notes)}</p>` : ""}
    <ul class="jr-stops">${a.items.map((x, i) => stopRow(x, cur, !!a.kept?.includes(i))).join("")}</ul>
    ${a.unclear?.length ? `<p class="hint jr-unclear">${icon("info")} Left open: ${esc(a.unclear.join("; "))}</p>` : ""}
    ${ex.length ? `<div class="jr-money"><div class="hint">Expenses it mentions:</div><ul>${ex.map((f) => `<li><span>${esc(f.what)}</span><span class="hint">${esc([f.paidBy ? `paid by ${f.paidBy}` : "", f.split?.length ? `for ${f.split.join(", ")}` : ""].filter(Boolean).join(" · "))}</span><b>${esc(shown(f.amount, f.currency))}</b></li>`).join("")}</ul>
      ${a.added ? `<span class="hint">${icon("check")} Added to Costs</span>` : ro ? "" : `<button type="button" class="btn" data-jr-add="${date}">${icon("wallet")} Add ${ex.length === 1 ? "it" : `all ${ex.length}`} to Costs</button>`}</div>` : ""}
    ${ro ? "" : `<button type="button" class="link-btn jr-drop" data-jr-drop="${date}" title="Forget this worked-out day (the entry stays)">Remove</button>`}
  </div>`;
}

function draw() {
  if (!dlg?.open) return;
  const body = dlg.querySelector<HTMLElement>(".jr-body")!, ro = isReadOnly(), top = body.scrollTop;
  const withText = days().filter((d) => entry(d.date)?.text.trim());
  const todo = withText.filter((d) => !state.actual?.[d.date] || stale(d.date));
  body.innerHTML = `
    <p class="hint">Write loosely what you really did each day: where you went, what you skipped and why, how you got around, who paid what. “Work out the day” reads it against the plan and writes the day as it went; the plan itself stays, and the itinerary's <b>Planned / Actual</b> switch shows either. The entry is sent to the model you chat with (${esc(modelName())}).</p>
    ${ro ? "" : `<div class="jr-tools">
      <label class="btn" title="The file the phone file saves with “Send”: its journal entries and expenses">${icon("upload")} Import from phone<input type="file" accept=".json,application/json" data-jr-import hidden></label>
      <button type="button" class="btn solid" data-jr-all${todo.length && !busy.size ? "" : " disabled"}>${icon("sparkles")} Work out ${todo.length ? `${todo.length} day${todo.length === 1 ? "" : "s"}` : "the days"}</button>
    </div>`}
    ${days().length ? days().map((d, i) => {
      const e = entry(d.date), a = state.actual?.[d.date], b = busy.get(d.date);
      return `<section class="jr-day" style="--c:${dayColor(i)}">
        <div class="jr-head"><span class="bal-dot">${i + 1}</span><span><b>${esc(fmtDate(d.date))}</b><small>${esc(String(d.city || d.title || ""))}</small></span></div>
        <div class="jr-plan hint">Planned: ${esc(d.items.filter((x) => x.kind !== "transfer").map((x) => x.place.split(",")[0]).join(" · ") || "nothing")}${e?.done?.length ? `<br>${icon("check")} Ticked on the phone: ${esc(e.done.join(" · "))}` : ""}</div>
        <textarea class="jr-text" data-jr-text="${d.date}" rows="${e?.text ? Math.min(10, Math.max(3, Math.ceil(e.text.length / 90))) : 2}" placeholder="What did you really do?"${ro ? " readonly" : ""}>${esc(e?.text || "")}</textarea>
        ${ro ? "" : `<div class="jr-acts">${b ? `<span class="hint jr-busy">${icon("hourglass")} <span data-jr-status="${d.date}">${esc(b.status)}</span></span><button type="button" class="btn" data-jr-stop="${d.date}">Stop</button>`
          : `<button type="button" class="btn" data-jr-work="${d.date}"${e?.text.trim() ? "" : " disabled"}>${icon("sparkles")} ${a ? "Work it out again" : "Work out the day"}</button>`}</div>`}
        ${a ? actualBlock(a, d.date, ro) : ""}
      </section>`;
    }).join("") : `<p class="hint">The journal goes by the plan's days: make a plan first.</p>`}`;
  body.scrollTop = top;
  const byDate = (date: string) => days().find((d) => d.date === date);
  for (const t of body.querySelectorAll<HTMLTextAreaElement>("[data-jr-text]")) {
    // Kept as they type; the buttons catch up when they leave the box.
    t.oninput = () => setEntry(t.dataset.jrText!, t.value);
    t.onchange = () => { draw(); redraw(); };
  }
  for (const b of body.querySelectorAll<HTMLButtonElement>("[data-jr-work]")) b.onclick = () => { const d = byDate(b.dataset.jrWork!); if (d) workOut(d); };
  for (const b of body.querySelectorAll<HTMLButtonElement>("[data-jr-stop]")) b.onclick = () => busy.get(b.dataset.jrStop!)?.abort.abort();
  for (const b of body.querySelectorAll<HTMLButtonElement>("[data-jr-add]")) b.onclick = () => addExpenses(b.dataset.jrAdd!);
  for (const b of body.querySelectorAll<HTMLButtonElement>("[data-jr-drop]")) {
    b.onclick = async () => {
      const date = b.dataset.jrDrop!;
      if (!(await askConfirm({ title: "Remove this worked-out day?", text: `${fmtDate(date)} goes back to showing the plan under Actual. Your journal entry stays${state.actual?.[date]?.added ? ", and so do the expenses already added to Costs" : ""}.`, ok: "Remove" }))) return;
      const actual = { ...(state.actual || {}) };
      delete actual[date];
      state.actual = Object.keys(actual).length ? actual : undefined;
      if (!hasActual()) session.showActual = false;
      save(); draw(); redraw();
    };
  }
  const all = body.querySelector<HTMLButtonElement>("[data-jr-all]");
  // One day after the other: a local model has one thing to do at a time, and a limit is easier on the others.
  if (all) all.onclick = async () => { for (const d of todo) { if (!dlg?.open) break; await workOut(d); } };
  const pick = body.querySelector<HTMLInputElement>("[data-jr-import]");
  if (pick) pick.onchange = () => { const f = pick.files?.[0]; pick.value = ""; if (f) importPhone(f); };
}

export function openJournal() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog journal-dialog";
    dlg.innerHTML = `<div class="pl-head"><h2>${icon("pencil")} Journal</h2><span class="hint">What you really did, day by day.</span>
      <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div><div class="jr-body"></div>`;
    document.body.append(dlg);
    closeOnBackdrop(dlg);
    dlg.addEventListener("close", () => redraw());
  }
  if (!dlg.open) dlg.showModal();
  draw();
}

/** The Planned / Actual switch above the days (only once a day has been worked out). */
export function actualSwitchHtml() {
  if (!hasActual()) return "";
  const n = Object.keys(state.actual || {}).filter((date) => days().some((d) => d.date === date)).length;
  return `<div class="actual-switch"><div class="segs"><button type="button" class="seg${session.showActual ? "" : " on"}" data-actual="0">Planned</button><button type="button" class="seg${session.showActual ? " on" : ""}" data-actual="1">Actual</button></div>
    <span class="hint">${session.showActual ? `As it really went, from your journal: ${n} of ${days().length} days; the others as planned. To change it, edit the journal.` : "The plan. Actual shows the trip as it really went, from your journal."}</span></div>`;
}

/** The trip as it really went, to read (not to edit: that's the journal): each day's actual version, or the planned
 *  day marked as such. */
export function actualDaysHtml(cur: string) {
  return actualDays(days(), state.actual).map((d, i) => {
    const real = !!state.actual?.[d.date], a = d as Partial<ActualDay> & Day;
    return `<div class="day actual-day${real ? "" : " as-planned"}" id="day-${i}" data-i="${i}" data-date="${esc(d.date)}" style="--c:${dayColor(i)}">
      <div class="day-head"><h4><span class="date">Day ${i + 1} · ${esc(fmtDate(d.date) || d.date)}</span>${esc(d.title || "")}</h4>
        <span class="right"><span class="actual-tag${real ? " real" : ""}">${real ? `${icon("check")} as it went` : "as planned"}</span>${d.estimatedCost ? `<span class="budget-pill">${esc(shown(d.estimatedCost, cur))}</span>` : ""}</span></div>
      ${d.notes ? `<p class="day-notes">${esc(d.notes)}</p>` : ""}
      <ul class="jr-stops">${d.items.map((x, k) => stopRow(x, cur, real && !!a.kept?.includes(k))).join("")}</ul>
      ${real && a.unclear?.length ? `<p class="hint jr-unclear">${icon("info")} Left open: ${esc(a.unclear.join("; "))}</p>` : ""}
    </div>`;
  }).join("");
}
