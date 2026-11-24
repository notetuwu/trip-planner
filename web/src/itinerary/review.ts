// Reviewing what the checks found: the problems on the left (a duplicated place once, with both its days), and the
// days involved side by side. A repeat that's meant to be there can be marked fine. Each day can be redone right away (lined up behind whatever is running, its progress shown
// in the itinerary) or put on a redo list that goes to the planner as one request.
import type { Itinerary } from "../../../shared/types";
import { esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { type Problem, type Stop, duplicateProblem, planProblems, setRepeatOk } from "../generate/autofix";
import { renderItinerary } from "./render";
import { dequeue, enqueue, jobForDay, onQueueChange } from "../generate/queue";
import { cleanStop } from "./duplicates";
import { removeStop } from "../map/edit";
import { hoursResult } from "./hours";

interface Issue {
  kind: NonNullable<Problem["kind"]>;
  /** The place, as the sidebar lists it. */
  title: string;
  /** The stops it's about: both copies of a duplicate. */
  stops: Stop[];
  days: number[];
  /** Under the stop: what's wrong, without the instructions meant for the planner. */
  note: string;
  /** A duplicate's shared name as matched, to mark it fine. */
  key?: string;
}

const KINDS: { kind: Issue["kind"]; head: string }[] = [
  { kind: "dup", head: "Duplicates" },
  { kind: "hours", head: "Closed when planned" },
  { kind: "far", head: "In the wrong town" },
];

/** The days on the redo list, sent to the planner together. */
const pool = new Set<number>();
/** What's shown: the problem picked (by its key) and its days, which stay on screen after a redo fixed it. */
let picked: { key: string; kind: Issue["kind"]; title: string; days: number[] } | null = null;
const pick = (i: Issue) => ({ key: issueKey(i), kind: i.kind, title: i.title, days: i.days });
let dlg: HTMLDialogElement | null = null;

const issueKey = (i: Issue) => `${i.kind}|${i.stops.map((s) => s.join("-")).join("|")}`;
const dayLabel = (it: Itinerary, d: number) => `Day ${d + 1}${it.days[d]?.date ? ` · ${fmtDate(it.days[d].date) || it.days[d].date}` : ""}`;
const daysLabel = (days: number[]) => (days.length === 1 ? `Day ${days[0] + 1}` : `Days ${days.slice(0, -1).map((d) => d + 1).join(", ")} and ${days[days.length - 1] + 1}`);
/** "\"Arena\" at 10:00: closed on Mondays. Move it…" → "Closed on Mondays." */
const shortNote = (text: string) => {
  // The time has a colon of its own ("at 10:30:"), so it's matched as a time, not up to the first colon.
  const s = text.replace(/^"[^"]*" at (?:\d{1,2}:\d{2}|\?)(?: on \w+)?:\s*/, "").replace(/[.;,]?\s*(Replace (?:it|this one)|Move it|Pick a different)[\s\S]*$/, "").replace(/,? which keeps it$/, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) + "." : "";
};

function issues(it: Itinerary): Issue[] {
  return planProblems(it).map((p): Issue => {
    const stops = [p.at, p.with].filter((s): s is Stop => !!s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // A duplicate goes by the shorter of its two names ("Case Mazzanti", not "Loggia di Frà Giocondo & Case Mazzanti").
    const names = stops.map((s) => cleanStop(it.days[s[0]].items[s[1]]?.place || ""));
    const title = names.reduce((a, b) => (b && b.length < a.length ? b : a), names[0] || "");
    const kind = p.kind || "far";
    return { kind, title, stops, days: [...new Set(stops.map((s) => s[0]))], note: kind === "dup" ? "" : shortNote(p.text), key: p.key };
  });
}

/** What the planner should fix on these days: each problem once, a duplicate on the day whose copy goes. */
function requestLines(it: Itinerary, days: number[]) {
  const lines: string[] = [];
  for (const p of planProblems(it)) {
    if (p.kind === "dup" && p.at && p.with) {
      const replaceHere = days.includes(p.at[0]), keepHere = days.includes(p.with[0]);
      // Only the day that keeps it is being redone: its copy goes instead.
      if (replaceHere) lines.push(`${dayLabel(it, p.at[0])}: ${p.text}`);
      else if (keepHere) lines.push(`${dayLabel(it, p.with[0])}: ${duplicateProblem(it, p.with, p.at).text}`);
    } else if (days.includes(p.day)) lines.push(`${dayLabel(it, p.day)}: ${p.text}`);
  }
  return lines;
}

function redoDay(day: number) {
  pool.delete(day);
  enqueue([day], `Day ${day + 1}`, () => {
    const it = state.itinerary;
    const lines = it ? requestLines(it, [day]) : [];
    if (!it || !lines.length) return null;
    return { redoDay: { itinerary: it, day, request: `Re-plan this day and fix what the checks found:\n- ${lines.join("\n- ")}` } };
  });
}

function redoPool() {
  const days = [...pool].sort((a, b) => a - b);
  pool.clear();
  enqueue(days, daysLabel(days), () => {
    const it = state.itinerary;
    const lines = it ? requestLines(it, days) : [];
    if (!it || !lines.length) return null;
    return { edit: { itinerary: it, days, request: `Fix what the checks found on these days. You may re-plan the rest of these days around the changes where that helps, but keep the towns, where they sleep, transfers and anything booked:\n- ${lines.join("\n- ")}` } };
  });
}

function sidebarHtml(list: Issue[]) {
  const ok = state.okRepeats || [];
  // Repeats marked fine, at the bottom: each can be flagged again.
  const okHtml = ok.length ? `<h3>Marked fine <span class="hint">${ok.length}</span></h3><ul>${ok.map((r) => `<li class="rv-ok"><span>${esc(r.name)}</span>
      <button class="icon-btn" data-unok="${esc(r.key)}" title="Flag it as a duplicate again">${icon("x")}</button></li>`).join("")}</ul>` : "";
  if (!list.length) return `<p class="hint rv-none">No problems left.</p>${okHtml}`;
  return issuesHtml(list) + okHtml;
}

function issuesHtml(list: Issue[]) {
  return KINDS.map(({ kind, head }) => {
    const of = list.filter((i) => i.kind === kind);
    if (!of.length) return "";
    return `<h3>${head} <span class="hint">${of.length}</span></h3><ul>${of.map((i) => {
      const busy = i.days.some((d) => jobForDay(d));
      return `<li><button class="rv-issue${picked?.key === issueKey(i) ? " on" : ""}" data-issue="${esc(issueKey(i))}">
        <b>${esc(i.title)}</b><span>${i.days.map((d) => `Day ${d + 1}`).join(" · ")}${busy ? ` · ${icon("refresh")}` : ""}</span>
      </button></li>`;
    }).join("")}</ul>`;
  }).join("");
}

function dayHtml(it: Itinerary, d: number, list: Issue[], shown: Issue | undefined) {
  const day = it.days[d];
  if (!day) return "";
  const job = jobForDay(d);
  const here = (xi: number) => list.filter((i) => i.stops.some((s) => s[0] === d && s[1] === xi));
  const status = !job ? "" : job.status === "running"
    ? `<div class="rv-status run"><span class="wait-dot"></span>Being redone now. The progress shows in the itinerary.</div>`
    : `<div class="rv-status">Waiting its turn${job.days.length > 1 ? ` (with ${esc(daysLabel(job.days.filter((x) => x !== d)))})` : ""}. <button class="link-btn" data-unqueue="${job.id}">Take off</button></div>`;
  const stops = day.items.map((x, xi) => {
    const mine = shown?.stops.some((s) => s[0] === d && s[1] === xi), other = !mine && here(xi).length > 0;
    const others = mine && shown?.kind === "dup" ? shown.stops.filter((s) => s[0] !== d) : [];
    const note = mine ? (shown!.kind === "dup" ? `Also on ${others.map((s) => esc(dayLabel(it, s[0]))).join(", ")}` : esc(shown!.note)) : other ? esc(here(xi).map((i) => (i.kind === "dup" ? "A duplicate" : i.note)).join(" ")) : "";
    return `<li class="${mine ? "rv-hit" : other ? "rv-other" : ""}">
      <span class="rv-time">${esc(x.time || "")}</span>
      <span class="rv-place">${esc(x.place)}${note ? `<span class="rv-note">${icon("warn")} ${note}</span>` : ""}</span>
      ${mine && shown?.kind === "dup" && !job ? `<button class="link-btn" data-rm="${d}-${xi}" title="Remove this copy; the other day keeps it">Remove</button>` : ""}
      ${(() => {
        // Planned a little before it opens: moved to the opening time in one click, no planner needed.
        const r = hoursResult(d, xi);
        return mine && shown?.kind === "hours" && !job && r?.status === "opens-later" && r.opens ? `<button class="link-btn" data-move="${d}-${xi}" data-to="${esc(r.opens)}" title="Start it when it opens; the stops after it stay as they are">Move to ${esc(r.opens)}</button>` : "";
      })()}
    </li>`;
  }).join("");
  return `<section class="rv-day${job ? " busy" : ""}">
    <header>
      <div><b>${esc(dayLabel(it, d))}</b><span class="hint">${esc(day.city || "")}</span></div>
      <div class="rv-acts">
        <button class="btn solid" data-redo-day="${d}" ${job ? "disabled" : ""}>${icon("refresh")} Redo this day</button>
        <button class="btn" data-pool="${d}" ${job ? "disabled" : ""} aria-pressed="${pool.has(d)}">${pool.has(d) ? "On redo list ✓" : "Add to redo list"}</button>
      </div>
    </header>
    ${status}
    <ol class="rv-stops">${stops}</ol>
  </section>`;
}

/** The problems, worked out once per change of the plan or the queue (the checks look up every stop), not per click. */
let cache: Issue[] | null = null;

/** Redraws everything after the plan or the queue changed. */
function render() {
  const it = state.itinerary;
  if (!dlg || !dlg.open || !it) return;
  cache = issues(it);
  renderMain();
  dlg.querySelector(".rv-side")!.innerHTML = sidebarHtml(cache);
  wireSide();
}

/** Redraws the days shown (and marks the picked problem in the list): all a click on a problem needs. */
function renderMain() {
  const it = state.itinerary;
  if (!dlg || !dlg.open || !it) return;
  const list = cache ??= issues(it);
  // The picked problem may be fixed by now: its days stay on screen, to see what changed.
  // Stops may have moved within their day: then it's the same kind of problem with the same place on the same days.
  const same = (i: Issue) => issueKey(i) === picked!.key || (i.kind === picked!.kind && i.title === picked!.title && `${i.days}` === `${picked!.days}`);
  let shown = picked ? list.find(same) : undefined;
  if (!picked && list.length) shown = list[0];
  if (shown) picked = pick(shown);
  const days = (picked?.days || []).filter((d) => it.days[d]);
  // A duplicate: what it is, and the way to say it's meant to be on both days.
  const dupBar = shown?.kind === "dup" && shown.key ? `<div class="rv-dupbar"><span><b>${esc(shown.title)}</b> is planned on ${esc(daysLabel(shown.days).replace(/^Days?/, (m) => m.toLowerCase()))}.
      Redo a day to replace one of them, or keep both.</span><button class="btn" data-ok-repeat title="It's meant to be on both days: stop flagging it">${icon("check")} Fine as is</button></div>` : "";
  const main = !days.length ? `<p class="hint rv-empty">Nothing to review. Every problem is fixed.</p>`
    : `${picked && !shown ? `<p class="rv-fixed">${icon("check")} Fixed. ${days.length > 1 ? "These days are" : "This day is"} shown as they are now.</p>` : dupBar}
       <div class="rv-days" style="--cols:${days.length}">${days.map((d) => dayHtml(it, d, list, shown)).join("")}</div>`;
  const tray = pool.size ? `<div class="rv-tray"><span>Redo list:</span>${[...pool].sort((a, b) => a - b).map((d) => `<span class="rv-chip">Day ${d + 1}<button class="icon-btn" data-unpool="${d}" title="Take off the list">${icon("x")}</button></span>`).join("")}
       <button class="btn solid" data-send-pool>Redo ${pool.size === 1 ? "this day" : `these ${pool.size} days`} in one go</button></div>` : "";
  dlg.querySelector(".rv-main")!.innerHTML = main + tray;
  for (const b of dlg.querySelectorAll<HTMLElement>("[data-issue]")) b.classList.toggle("on", b.dataset.issue === picked?.key);
  wireMain(shown);
}

function wireSide() {
  const $$b = (sel: string) => dlg!.querySelectorAll<HTMLButtonElement>(sel);
  for (const b of $$b("[data-issue]")) b.onclick = () => {
    const i = cache?.find((x) => issueKey(x) === b.dataset.issue);
    if (i) { picked = pick(i); renderMain(); }
  };
  // Marked fine earlier: flag it again.
  for (const b of $$b("[data-unok]")) b.onclick = () => {
    const r = (state.okRepeats || []).find((x) => x.key === b.dataset.unok);
    if (r) { setRepeatOk(r.key, r.name, false); save(); renderItinerary(); }
  };
}

function wireMain(shown: Issue | undefined) {
  const $$b = (sel: string) => dlg!.querySelectorAll<HTMLButtonElement>(sel);
  for (const b of $$b("[data-redo-day]")) b.onclick = () => redoDay(+b.dataset.redoDay!);
  for (const b of $$b("[data-pool]")) b.onclick = () => { const d = +b.dataset.pool!; if (pool.has(d)) pool.delete(d); else pool.add(d); renderMain(); };
  for (const b of $$b("[data-unpool]")) b.onclick = () => { pool.delete(+b.dataset.unpool!); renderMain(); };
  for (const b of $$b("[data-send-pool]")) b.onclick = () => redoPool();
  for (const b of $$b("[data-unqueue]")) b.onclick = () => dequeue(+b.dataset.unqueue!);
  for (const b of $$b("[data-rm]")) b.onclick = () => { const [d, x] = b.dataset.rm!.split("-").map(Number); removeStop(d, x); };
  for (const b of $$b("[data-move]")) b.onclick = () => {
    const [d, x] = b.dataset.move!.split("-").map(Number), stop = state.itinerary?.days[d]?.items[x];
    if (!stop) return;
    stop.time = b.dataset.to!;
    save(); renderItinerary();
  };
  const ok = dlg!.querySelector<HTMLButtonElement>("[data-ok-repeat]");
  if (ok && shown?.key) ok.onclick = () => {
    setRepeatOk(shown.key!, shown.title, true);
    // On to the next problem rather than a "fixed" note for this one.
    picked = null;
    save(); renderItinerary();
  };
}

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "keys-dialog review-dialog";
  dlg.innerHTML = `<div class="pl-head"><h2>${icon("warn")} Problems in the plan</h2>
      <span class="hint">Pick a problem to see its days. Redo a day now, or collect days on the redo list and send them together.</span>
      <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
    <div class="rv-body"><aside class="rv-side"></aside><div class="rv-main"></div></div>`;
  document.body.append(dlg);
  // Redos starting and ending (and the plan changing with them) show here as they happen.
  onQueueChange(render);
  return dlg;
}

/** Opens the review, on the problem with this stop if given (else the one already picked, or the first). */
export function openReview(stop?: Stop) {
  const it = state.itinerary;
  if (!it) return;
  const d = ensureDialog();
  if (stop) {
    const i = issues(it).find((x) => x.stops.some((s) => s[0] === stop[0] && s[1] === stop[1]));
    if (i) picked = pick(i);
  }
  if (!d.open) d.showModal();
  render();
}

/** The plan changed (a redo landed, a stop was removed or put back): show it as it is now. */
export function refreshReview() { render(); }
