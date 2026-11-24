// The days of the itinerary: city bands, stops (with split groups side by side), notes, and the extras at the end.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { esc } from "../core/dom";
import { dayColor, fmtDate, fmtTemp, fmtTime, money, addDays } from "../core/format";
import { session, state } from "../core/state";
import type { ByTitle } from "../geo/item-loc";
import { dayGroupColors, splitGroup } from "../trip/modes";
import { bookLink } from "./book-ahead";
import { directionsUrl, mealSearchUrl } from "./directions";
import { genericMeal, mapsName, placeUrl } from "../core/maps-links";
import { itemLoc, stopMapsUrl } from "../geo/item-loc";
import { distKm, placeLoc, stayLoc } from "../geo/locate";
import { tipHtml } from "./tips";
import { wmoIcon } from "./weather";
import { ext, icon } from "../core/icons";
import { isTransfer, onMap } from "../map/travel-day";

/** The stop's name links to it in the maps app: a saved place's own link (see placeUrl), the exact spot where it's known,
 *  else a search for "name, town" (for a meal without a place: what's there to eat). */
function mapsLink(x: ItineraryItem, d: Day, di: number, xi: number, byTitle: ByTitle) {
  const listed = byTitle.get(x.place);
  if (listed?.url) return placeUrl({ ...listed, ...(placeLoc(listed) || {}) });
  const meal = mealSearchUrl(di, xi);
  if (meal) return meal;
  return stopMapsUrl(x, d, itemLoc(x, d, byTitle));
}

/** Their must-sees, by name without accents, case and punctuation. */
const norm = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Rebuilt on every render (marks change in place). */
let mustSet = new Set<string>();
const refreshMustSees = () => { mustSet = new Set(Object.keys(state.marks).filter((t) => state.marks[t] === "must").map(norm)); };
function isMustSee(x: ItineraryItem) {
  if (x.mustSee) return true;
  const n = norm(x.place);
  return !!n && (mustSet.has(n) || [...mustSet].some((m) => m.length > 5 && n.length > 5 && (n.includes(m) || m.includes(n))));
}

/** xi is the item's index within its day; it matches the numbered pin on the map. */
function itemHtml(d: Day, di: number, x: ItineraryItem, xi: number, byTitle: ByTitle, cur: string) {
  const meal = genericMeal(x.place);
  const dir = directionsUrl(di, xi) ? (meal
    ? `<a class="dir" data-dir="${di}-${xi}" href="#" target="_blank" rel="noopener" title="${esc(`${meal.what[0].toUpperCase()}${meal.what.slice(1)} around here in ${mapsName()}`)}">Find ${esc(meal.what)}${ext()}</a>`
    : `<a class="dir" data-dir="${di}-${xi}" href="#" target="_blank" rel="noopener" title="Directions to here in ${mapsName()}">Route${ext()}</a>`) : "";
  const links = [dir, bookLink(x, d, di, xi)].filter(Boolean).join(" · ");
  const badge = x.booking === "essential" ? `<span class="book-badge" title="${esc(x.bookAhead ? `Book ${x.bookAhead}` : "Book ahead")}">book ahead</span>` : "";
  const must = isMustSee(x), listed = x.fromList || byTitle.has(x.place);
  // Transfers ("Rigi Kulm → Vitznau") have no single spot until they set where it ends; anything else placed only
  // roughly gets its "Set location" button highlighted.
  const transfer = isTransfer(x), where = onMap(x) ? itemLoc(x, d, byTitle) : null;
  const pinGuess = !transfer && !x.pinned && (!where || !!where.approx);
  const pinTitle = transfer ? (x.pinned ? "Change where this leg ends on the map" : "Set where this leg ends, to draw it on the map (like the foot of the mountain)")
    : pinGuess ? "The location is only estimated: set where it really is" : "Set where this stop is";
  return `
    <li class="item${must ? " must" : listed ? " listed" : ""}" data-k="${di}-${xi}">
      <div class="item-top">
        <time>${esc(fmtTime(x.time))}</time>
        <span class="n">${xi + 1}</span>
        <span class="name"><a href="${esc(mapsLink(x, d, di, xi, byTitle))}" target="_blank" rel="noopener">${esc(x.place)}</a>${must ? `<span class="must-tag" title="One of your must-sees">${icon("star")} must-see</span>` : ""}${badge}</span>
        ${x.cost ? `<span class="cost">${money(x.cost, cur)}</span>` : ""}
        <span class="item-acts">
        ${where ? `<button class="pin${x.leg ? " set" : ""}" data-leg-edit="${di}-${xi}" title="${x.leg ? "How you get here is set by hand: change it" : "How you get here: walk, road, train, boat, places on the way"}">${icon("route")}</button>` : ""}
        ${where ? `<button class="pin show-on-map" data-show="${di}-${xi}" title="Show on the map">${icon("pin")}</button>` : ""}
        <button class="pin${pinGuess ? " guess" : ""}" data-pin="${di}-${xi}" title="${pinTitle}">${icon("crosshair")}</button>
        <button class="del" data-del="${di}-${xi}" title="Remove this stop">${icon("x")}</button>
        </span>
      </div>
      ${x.description ? `<div class="desc">${esc(x.description)}</div>` : ""}
      ${x.transport || links ? `<div class="transport">${esc(x.transport || "")}${links ? `<span class="t-links">${x.transport ? " · " : ""}${links}</span>` : ""}</div>` : ""}
      <div class="leg" data-leg="${di}-${xi}"></div>
      <div class="far-warn" data-far="${di}-${xi}" hidden></div>
      <div class="far-warn" data-hours="${di}-${xi}" hidden></div>
      <div class="far-warn dup-warn" data-dup="${di}-${xi}" hidden></div>
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
  refreshMustSees();
  return daysGroups(it, byTitle, cur, budget) + (it.days.length ? `</div></section>` : "");
}

function daysGroups(it: Itinerary, byTitle: ByTitle, cur: string, budget: number) {
  let html = "", group: number | null = null;
  // Which stay a day belongs to: the one you sleep at that night (the last day, when you leave, goes with the stay before).
  const stayOf = (date: string) => state.stays.findIndex((s) => s.start && Number(s.nights) > 0 && date >= s.start && date < addDays(s.start, Number(s.nights)));
  // Each day's group, worked out once: its stay, or (the last day, when you leave) the one before it.
  const groups: number[] = [];
  it.days.forEach((d, i) => { const s = stayOf(d.date); groups.push(s >= 0 ? s : i ? groups[i - 1] : -1); });
  it.days.forEach((d, i) => {
    const trackColor = dayGroupColors(d.items, i);
    const si = groups[i];
    if (si !== group || i === 0) {
      // A new stay: close the last group, and open one with a heading that folds its days away.
      if (group !== null) html += `</div></section>`;
      const s = state.stays[si], n = groups.filter((g) => g === si).length;
      const town = s ? s.city.split(",")[0] : d.city;
      const when = s?.start ? `${fmtDate(s.start)} – ${fmtDate(addDays(s.start, Number(s.nights)))}` : "";
      html += `<section class="stay-group${session.foldedStays.has(si) ? " folded" : ""}" data-stay-group="${si}">
        <div class="city-band" data-fold-stay="${si}" title="Fold or unfold this stay's days">
          <span class="fold-arrow">${icon("chevronDown")}</span><span class="band-town">${esc(town)}</span>
          <span class="band-meta">${esc([when, `${n} day${n === 1 ? "" : "s"}`].filter(Boolean).join(" · "))}</span>
          ${si >= 0 ? `<button class="link-btn replan-stay" data-replan-stay="${si}" title="Re-plan all days of this stay together, e.g. after booking something">${icon("refresh")} <span>Re-plan this stay</span></button>` : ""}
        </div>
        <div class="stay-days">`;
      group = si;
    }
    const w = session.weather[d.date];
    html += `<div class="day ${session.selectedDay === i ? "selected" : ""}" id="day-${i}" data-i="${i}" data-date="${esc(d.date)}" style="--c:${dayColor(i)}">
      <div class="day-head" data-sel="${i}" title="Show this day on the map">
        <h4><span class="date">Day ${i + 1} · ${esc(fmtDate(d.date) || d.date)}</span>${esc(d.title)}${d.items.some(splitGroup) ? `<span class="split-pill">⑂ split</span>` : ""}</h4>
        <span class="right">
          ${w ? `<span class="weather" title="Forecast">${wmoIcon(w.code)}${fmtTemp(w.max)} / ${fmtTemp(w.min)}</span>` : ""}
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

/** Places the planner could pick from (lists with Suggest on) near the stays that aren't in the plan, and that it gave
 *  no reason for: so it's clear what was left out, not only what it chose to mention. */
function otherUnused(it: Itinerary) {
  const planned = it.days.flatMap((d) => d.items.map((x) => norm(x.place)));
  const said = new Set((it.unused || []).map((u) => norm(u.place)));
  const stays = state.stays.map(stayLoc).filter((l): l is NonNullable<typeof l> => !!l);
  const used = (n: string) => planned.some((p) => p === n || (n.length > 5 && p.length > 5 && (p.includes(n) || n.includes(p))));
  return session.places.filter((p) => session.fullTitles.has(p.title) && state.marks[p.title] !== "skip")
    .filter((p) => { const n = norm(p.title); return n && !said.has(n) && !used(n); })
    .filter((p) => { const l = placeLoc(p); return !l || !stays.length || stays.some((s) => distKm(s, l) < 60); });
}

/** Tips, places that didn't fit, sources, and how the plan was made. */
export function extrasHtml(it: Itinerary) {
  let html = "";
  const others = otherUnused(it);
  if (it.tips?.length || it.unused?.length || it.sources?.length || others.length) {
    html += `<div class="extras">`;
    if (it.tips?.length) html += `<div><h2>Tips</h2><ul>${it.tips.map((t) => `<li>${tipHtml(t)}</li>`).join("")}</ul></div>`;
    if (it.unused?.length || others.length) {
      html += `<div><h2>Not in the plan</h2>${it.unused?.length ? `<ul>${it.unused.map((u) => `<li>${esc(u.place)} <div class="reason">${esc(u.reason)}</div></li>`).join("")}</ul>` : ""}${others.length
        ? `<details class="unused-more"><summary>${it.unused?.length ? "Other s" : "S"}uggested places nearby not used (${others.length})</summary><p class="hint">From your lists with Suggest on, near your stays; the planner didn't say why. Ask in the trip chat to fit one in.</p><ul>${others.slice(0, 80).map((p) => `<li>${esc(p.title)}</li>`).join("")}${others.length > 80 ? `<li class="hint">and ${others.length - 80} more</li>` : ""}</ul></details>` : ""}</div>`;
    }
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
