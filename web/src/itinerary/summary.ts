// The top of the itinerary: stale warning, title, cost stats and bars, the toolbar and Ask for changes.
import type { Itinerary } from "../../../shared/types";
import { esc } from "../core/dom";
import { dayColor, fmtDate, fmtShort } from "../core/format";
import { staysKey, state } from "../core/state";
import { sameName } from "../geo/locate";
import type { ByTitle } from "../geo/item-loc";
import { bookAheadCount } from "./book-ahead";
import { packingCount } from "./packing";
import { promptSummary } from "./panels";
import { icon } from "../core/icons";
import { balances, settleUp, spending } from "../../../shared/expenses";
import { displayPicker, fx, shown } from "./costs-data";

/** The stays have changed since this itinerary was made (e.g. a new trip typed over an old one). */
/** The stays changed since the plan was made (for older plans: it starts on another day, or no day is in a stay's town). */
function isStale(it: Itinerary) {
  if (state.meta?.staysKey) return state.meta.staysKey !== staysKey();
  // Towns without their country ("Salzburg, Austria" is "Salzburg"); a day's town may be "Venice → Salzburg".
  const cities = new Set(state.stays.map((s) => sameName(s.city)).filter(Boolean));
  const dayTowns = (d: Itinerary["days"][number]) => String(d.city).split(/→|->|\/|,|\s-\s/).map(sameName);
  return (!!state.stays[0]?.start && it.days[0]?.date !== state.stays[0].start)
    || (cities.size > 0 && !it.days.some((d) => dayTowns(d).some((t) => cities.has(t))));
}

export function eventsHtml(it: Itinerary) {
  if (!it.holidaysAndEvents?.length) return "";
  // Collapsed by default: the names show in the summary line, the details when opened.
  const names = it.holidaysAndEvents.map((h) => h.name.replace(/\s*\(.*$/, "")).join(", ");
  return `<details class="events fold" data-fold="events">
    <summary><h2>Holidays &amp; events</h2><span class="hint">${it.holidaysAndEvents.length} · ${esc(names.length > 110 ? names.slice(0, 110) + "…" : names)}</span></summary>
    <ul>${it.holidaysAndEvents.map((h) => {
      const [a, b] = String(h.date || "").split("..");
      const when = b ? `${fmtShort(a)} – ${fmtShort(b)}` : fmtDate(a) || h.date;
      return `<li><span class="ev-date">${esc(when)}</span><div><b>${esc(h.name)}</b>${h.where ? ` <span class="hint">· ${esc(h.where)}</span>` : ""}<div>${esc(h.impact)}</div></div></li>`;
    }).join("")}</ul>
  </details>`;
}

/** A button in the toolbar that opens one of the itinerary's sections in a window. */
const sectionBtn = (kind: string, ic: Parameters<typeof icon>[0], label: string, count: string, title: string) =>
  `<button type="button" data-section="${kind}" title="${esc(title)}">${icon(ic)}<span class="tb-label">${label}</span>${count ? `<span class="tb-count">${esc(count)}</span>` : ""}</button>`;

/** The top of the itinerary: the title (with the reasoning, prompt and key behind small buttons), the cost stats and
 *  the daily bars, and one toolbar with the exports on the left and the sections (holidays, book ahead, packing) on the
 *  right, each opening in a window. */
export function summaryHtml(it: Itinerary, byTitle: ByTitle, cur: string, budget: number) {
  const meta = state.meta || {};
  const listedCount = new Set(it.days.flatMap((d) => d.items.filter((x) => x.fromList || byTitle.has(x.place)).map((x) => x.place))).size;
  const maxCost = Math.max(budget, ...it.days.map((d) => d.estimatedCost || 0)) || 1;
  const stale = isStale(it) ? `<div class="stale">This itinerary doesn't match your current stays.
    <span><button class="btn" data-stale="clear">Clear it</button> <button class="btn solid" data-stale="gen">Generate new</button></span></div>` : "";
  const thoughts = !!(it.summary || meta.reasoning || meta.thinking || meta.lookups?.length);
  const events = it.holidaysAndEvents?.length || 0;
  const ahead = bookAheadCount(it), pack = packingCount(it);
  // What was really spent (rates as entered; today's for the rest, once loaded) and how many payments would even it out.
  const ex = Object.values(state.expenses || {}), names = state.people || [];
  const spent = spending(ex, names, cur, fx).total;
  const owing = names.length > 1 ? settleUp(balances(ex, names, cur, fx), cur).length : 0;
  return `${stale}<div class="summary">
    <div class="sum-head">
      <h3>${it.days.length} days${it.destination ? ` in ${esc(it.destination)}` : ""}</h3>
      ${displayPicker("data-show-cur")}
      <div class="sum-icons">
        ${thoughts ? `<button type="button" class="icon-btn" data-section="reasoning" title="How the plan was made: the overview and the planner's reasoning${meta.lookups?.length ? ` (${meta.lookups.length} lookups)` : ""}" aria-label="Reasoning">${icon("brain")}</button>` : ""}
        ${meta.prompt?.length ? `<button type="button" class="icon-btn" data-section="prompt" title="${esc(promptSummary(meta.prompt))}" aria-label="Prompt">${icon("prompt")}</button>` : ""}
        <button type="button" class="icon-btn" data-section="key" title="What's what: the dots, tags, links and map lines" aria-label="Key">${icon("info")}</button>
      </div>
    </div>
    <div class="stats">
      <button class="stat stat-btn" type="button" data-costs title="Costs: change the estimates, note what you paid and who paid it, and who owes whom"><b>${shown(it.totalEstimatedCost, cur)}</b><span>est. total · costs</span></button>
      ${spent ? `<button class="stat stat-btn" type="button" data-costs="spent" title="What you really spent, and who owes whom"><b>${shown(spent, cur)}</b><span>really spent · ${owing ? `${owing} to pay back` : "all even"}</span></button>` : ""}
      <div class="stat"><b>${shown(it.totalEstimatedCost / Math.max(1, it.days.length), cur)}</b><span>avg / day for ${state.travelers > 1 ? `all ${state.travelers}` : "you"}</span><span class="stat-line">budget ${shown(budget, cur, true)}</span>${state.travelers > 1 ? `<span class="stat-line">${shown(budget / state.travelers, cur, true)} each</span>` : ""}</div>
      <div class="stat"><b>${listedCount}</b><span>saved places used</span></div>
      ${it.localCurrency && it.localCurrency !== cur ? `<div class="stat"><b>${esc(it.localCurrency)}</b><span>local currency</span></div>` : ""}
    </div>
    <div class="bars" title="Daily cost vs budget">
      <div class="budget-line" style="bottom:${(budget / maxCost) * 100}%"></div>
      ${it.days.map((d, i) => `<button style="--c:${dayColor(i)};height:${Math.max(4, (d.estimatedCost / maxCost) * 100)}%" class="${d.estimatedCost > budget ? "over" : ""}" data-bar="${i}" title="${esc(fmtDate(d.date))}: ${esc(shown(d.estimatedCost, cur))}"></button>`).join("")}
    </div>
    <div class="toolbar">
      <div class="tb-group">
        <button type="button" class="tb-export" data-export aria-haspopup="menu" aria-expanded="false" title="The plan for your phone, your calendar, other map apps, paper or a file">${icon("download")}<span class="tb-label">Export</span>${icon("chevronDown")}</button>
        <button data-tool="clear" class="danger" title="Clear this itinerary" aria-label="Clear this itinerary">${icon("trash")}</button>
      </div>
      <div class="tb-group tb-sections">
        ${events ? sectionBtn("events", "party", "Holidays", String(events), `Holidays & events: ${it.holidaysAndEvents!.map((h) => h.name.replace(/\s*\(.*$/, "")).join(", ").slice(0, 200)}`) : ""}
        ${ahead.total ? sectionBtn("ahead", "ticket", "Book ahead", ahead.left ? `${ahead.left} left` : "done", `Book ahead: ${ahead.left ? `${ahead.left} of ${ahead.total} still to book` : `all ${ahead.total} booked`} (stays, transport and tickets)`) : ""}
        ${sectionBtn("packing", "luggage", "Packing", `${pack.done}/${pack.all}`, `Packing list: ${pack.done} of ${pack.all} packed`)}
        <button type="button" data-preview title="The trip in pictures: highlights, day by day, and a slideshow">${icon("play")}<span class="tb-label">Preview</span></button>
        <button type="button" data-photos title="The photos and videos of this trip: choose the folders, see them by day">${icon("images")}<span class="tb-label">Photos</span></button>
      </div>
    </div>
    <button type="button" class="refine" id="refineBtn">${icon("chat")}<span><b>Ask for changes</b> in the trip chat, e.g. “swap days 3 and 4” or “add a vegan lunch spot on day 6”</span></button>
  </div>`;
}
