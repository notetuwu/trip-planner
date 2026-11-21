// The top of the itinerary: stale warning, summary, reasoning, holidays, cost stats and bars, tools and Revise.
import type { Itinerary } from "../../../shared/types";
import { esc } from "../core/dom";
import { dayColor, fmtDate, fmtShort, money } from "../core/format";
import { state } from "../core/state";
import type { ByTitle } from "../geo/item-loc";
import { bookAheadHtml } from "./book-ahead";
import { packingHtml } from "./packing";
import { promptHtml, thoughtsHtml } from "./panels";
import { icon } from "../core/icons";
import { canShareFiles } from "../export/offline";

/** The stays have changed since this itinerary was made (e.g. a new trip typed over an old one). */
function isStale(it: Itinerary) {
  const cities = new Set(state.stays.map((s) => s.city.trim().toLowerCase()).filter(Boolean));
  return (!!state.stays[0]?.start && it.days[0]?.date !== state.stays[0].start)
    || (cities.size > 0 && !it.days.some((d) => cities.has(String(d.city).trim().toLowerCase())));
}

function eventsHtml(it: Itinerary) {
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

export function summaryHtml(it: Itinerary, byTitle: ByTitle, cur: string, budget: number) {
  const meta = state.meta || {};
  const listedCount = new Set(it.days.flatMap((d) => d.items.filter((x) => x.fromList || byTitle.has(x.place)).map((x) => x.place))).size;
  const maxCost = Math.max(budget, ...it.days.map((d) => d.estimatedCost || 0)) || 1;
  const stale = isStale(it) ? `<div class="stale">This itinerary doesn't match your current stays.
    <span><button class="btn" data-stale="clear">Clear it</button> <button class="btn solid" data-stale="gen">Generate new</button></span></div>` : "";
  return `${stale}<div class="summary">
    <h3>${it.days.length} days${it.destination ? ` in ${esc(it.destination)}` : ""}</h3>
    <p>${esc(it.summary)}</p>
    ${meta.reasoning || meta.thinking || meta.lookups?.length ? thoughtsHtml(meta.reasoning, { thinking: meta.thinking, lookups: meta.lookups || [] }) : ""}
    ${meta.prompt?.length ? promptHtml(meta.prompt) : ""}
    ${eventsHtml(it)}
    ${bookAheadHtml(it)}
    ${packingHtml(it)}
    <div class="stats">
      <div class="stat"><b>${money(it.totalEstimatedCost, cur)}</b><span>est. total</span></div>
      <div class="stat"><b>${money(it.totalEstimatedCost / Math.max(1, it.days.length), cur)}</b><span>avg / day (budget ${money(budget, cur)})</span></div>
      <div class="stat"><b>${listedCount}</b><span>saved places used</span></div>
      ${it.localCurrency && it.localCurrency !== cur ? `<div class="stat"><b>${esc(it.localCurrency)}</b><span>local currency</span></div>` : ""}
    </div>
    <div class="bars" title="Daily cost vs budget">
      <div class="budget-line" style="bottom:${(budget / maxCost) * 100}%"></div>
      ${it.days.map((d, i) => `<button style="--c:${dayColor(i)};height:${Math.max(4, (d.estimatedCost / maxCost) * 100)}%" class="${d.estimatedCost > budget ? "over" : ""}" data-bar="${i}" title="${esc(fmtDate(d.date))}: ${esc(money(d.estimatedCost, cur))}"></button>`).join("")}
    </div>
    <div class="toolbar">
      <button data-tool="phone" title="Save one self-contained file that works offline on your phone (send it with Phone Link, AirDrop, a messenger or email)">${icon("phone")} For phone</button>
      ${canShareFiles() ? `<button data-tool="share" title="Send the phone file with the system share menu">${icon("share")} Share</button>` : ""}
      <button data-tool="ics" title="Every stop as an event, for your phone's calendar">${icon("calendar")} Calendar</button>
      <button data-tool="print" title="Print it or save it as a PDF">${icon("printer")} Print / PDF</button>
      <button data-tool="json" title="The itinerary as a JSON file">${icon("download")} JSON</button>
      <button data-tool="clear" class="danger" title="Clear this itinerary" aria-label="Clear this itinerary">${icon("trash")}</button>
    </div>
    <div class="refine">
      <label for="refineText">Ask for changes</label>
      <textarea id="refineText" rows="2" placeholder="e.g. “swap days 3 and 4” or “add a vegan lunch spot on day 6”"></textarea>
      <div class="refine-actions"><button class="btn solid" id="refineBtn">Revise the plan</button></div>
    </div>
  </div>`;
}
