// The days of the itinerary: city bands, stops (with split groups side by side), notes, and the extras at the end.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { esc } from "../core/dom";
import { dayColor, fmtDate, money } from "../core/format";
import { session, state } from "../core/state";
import type { ByTitle } from "../geo/item-loc";
import { splitGroup } from "../trip/modes";
import { bookLink } from "./book-ahead";
import { directionsUrl } from "./directions";
import { tipHtml } from "./tips";
import { wmoIcon } from "./weather";
import { ext, icon } from "../core/icons";

const mapsLink = (x: ItineraryItem, d: Day, byTitle: ByTitle) => byTitle.get(x.place)?.url ||
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.place}, ${d.city}`)}`;

/** xi is the item's index within its day; it matches the numbered pin on the map. */
function itemHtml(d: Day, di: number, x: ItineraryItem, xi: number, byTitle: ByTitle, cur: string) {
  const dir = directionsUrl(di, xi) ? `<a class="dir" data-dir="${di}-${xi}" href="#" target="_blank" rel="noopener" title="Directions to here in Google Maps">Route${ext()}</a>` : "";
  const links = [dir, bookLink(x, d, di, xi)].filter(Boolean).join(" · ");
  const badge = x.booking === "essential" ? `<span class="book-badge" title="${esc(x.bookAhead ? `Book ${x.bookAhead}` : "Book ahead")}">book ahead</span>` : "";
  return `
    <li class="item ${x.fromList || byTitle.has(x.place) ? "listed" : ""}" data-k="${di}-${xi}">
      <div class="item-top">
        <time>${esc(x.time)}</time>
        <span class="n">${xi + 1}</span>
        <span class="name"><a href="${esc(mapsLink(x, d, byTitle))}" target="_blank" rel="noopener">${esc(x.place)}</a>${badge}</span>
        ${x.cost ? `<span class="cost">${money(x.cost, cur)}</span>` : ""}
        <button class="del" data-del="${di}-${xi}" title="Remove this stop">${icon("x")}</button>
      </div>
      ${x.description ? `<div class="desc">${esc(x.description)}</div>` : ""}
      ${x.transport || links ? `<div class="transport">${esc(x.transport || "")}${x.transport && links ? " · " : ""}${links}</div>` : ""}
      <div class="leg" data-leg="${di}-${xi}"></div>
      <div class="far-warn" data-far="${di}-${xi}" hidden></div>
      <div class="far-warn" data-hours="${di}-${xi}" hidden></div>
    </li>`;
}

/** Consecutive items with a group label form one fork: a column per subgroup, side by side. */
function dayItemsHtml(d: Day, di: number, byTitle: ByTitle, cur: string, trackColor: Record<string, number>) {
  const item = (x: ItineraryItem, i: number) => itemHtml(d, di, x, i, byTitle, cur);
  let out = "", run: { x: ItineraryItem; i: number }[] = [];
  const flush = () => {
    if (!run.length) return;
    const tracks = new Map<string, typeof run>();
    for (const r of run) { const g = r.x.group!; if (!tracks.has(g)) tracks.set(g, []); tracks.get(g)!.push(r); }
    const cols = [...tracks].map(([label, rs]) => {
      trackColor[label] ??= Object.keys(trackColor).length % 4;
      const people = rs.find((r) => r.x.people)?.x.people;
      return `<div class="track t${trackColor[label]}">
        <div class="track-head">${esc(label)}${people ? `<span>${icon("users")} ${people}</span>` : ""}</div>
        <ul class="items">${rs.map((r) => item(r.x, r.i)).join("")}</ul>
      </div>`;
    });
    out += `<li class="fork"><div class="fork-label">Group splits up</div><div class="tracks">${cols.join("")}</div></li>`;
    run = [];
  };
  d.items.forEach((x, i) => {
    if (splitGroup(x)) run.push({ x, i });
    else { flush(); out += item(x, i); }
  });
  flush();
  return out;
}

export function daysHtml(it: Itinerary, byTitle: ByTitle, cur: string, budget: number) {
  let html = "", lastCity: string | null = null;
  const trackColor: Record<string, number> = {};
  it.days.forEach((d, i) => {
    if (d.city !== lastCity) { html += `<div class="city-band">${esc(d.city)}</div>`; lastCity = d.city; }
    const w = session.weather[d.date];
    html += `<div class="day ${session.selectedDay === i ? "selected" : ""}" id="day-${i}" data-i="${i}" data-date="${esc(d.date)}" style="--c:${dayColor(i)}">
      <div class="day-head" data-sel="${i}" title="Show this day on the map">
        <h4><span class="date">${esc(fmtDate(d.date) || d.date)}</span>${esc(d.title)}${d.items.some(splitGroup) ? `<span class="split-pill">⑂ split</span>` : ""}</h4>
        <span class="right">
          ${w ? `<span class="weather" title="Forecast">${wmoIcon(w.code)}${Math.round(w.max)}° / ${Math.round(w.min)}°</span>` : ""}
          <span class="budget-pill ${d.estimatedCost > budget ? "over" : ""}">${money(d.estimatedCost, cur)}</span>
          <button class="redo" data-redo="${i}" title="Re-plan this day (keeps the other days)">${icon("refresh")}</button>
        </span>
      </div>
      <ul class="items">${dayItemsHtml(d, i, byTitle, cur, trackColor)}</ul>
      ${d.notes ? `<div class="day-notes">${esc(d.notes)}</div>` : ""}
    </div>`;
  });
  return html;
}

/** Tips, places that didn't fit, sources, and how the plan was made. */
export function extrasHtml(it: Itinerary) {
  let html = "";
  if (it.tips?.length || it.unused?.length || it.sources?.length) {
    html += `<div class="extras">`;
    if (it.tips?.length) html += `<div><h2>Tips</h2><ul>${it.tips.map((t) => `<li>${tipHtml(t)}</li>`).join("")}</ul></div>`;
    if (it.unused?.length) html += `<div><h2>Didn't fit</h2><ul>${it.unused.map((u) => `<li>${esc(u.place)} <div class="reason">${esc(u.reason)}</div></li>`).join("")}</ul></div>`;
    if (it.sources?.length) html += `<div><h2>Sources</h2><ul class="sources">${it.sources.filter((s) => /^https?:\/\//.test(s)).map((s) =>
      `<li><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80))}</a></li>`).join("")}</ul></div>`;
    html += `</div>`;
  }
  const meta = state.meta || {};
  const tokenStats = meta.tokens ? ` · ${meta.tokens.toLocaleString()} tokens${meta.perSec ? ` at ${Math.round(meta.perSec)} tok/s` : ""}` : "";
  const billing = meta.billing || (meta.local ? "local" : "plan");
  const searches = meta.searches ? ` · ${meta.searches} web searches` : "";
  if (meta.durationMs) html += `<p class="counts gen-meta" style="margin-top:20px">Generated in ${Math.round(meta.durationMs / 1000)}s${tokenStats}${searches} ${
    billing === "local" ? `by ${esc(meta.engine)}, running on this computer (free)`
    : billing === "api" ? `by ${esc(meta.engine)}, billed to your API key${meta.costUsd != null ? ` (about $${meta.costUsd.toFixed(2)})` : ""}`
    : `${meta.engine ? `by ${esc(meta.engine)}` : "via Claude Code"} (counts toward your Claude plan usage, no API charges)`}</p>`;
  return html;
}
