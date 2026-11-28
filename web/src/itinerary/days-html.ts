// The days of the itinerary: city bands, stops (with split groups side by side), notes, and the extras at the end.
import { dayKey } from "../../../shared/edits";
import { addStopHtml } from "./manual";
import { editChip } from "../saves/collab";
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { esc } from "../core/dom";
import { dayColor, fmtDate, fmtTemps, fmtTime, addDays } from "../core/format";
import { session, state } from "../core/state";
import type { ByTitle } from "../geo/item-loc";
import { byWho, dayGroupColors, parentGroup, splitGroup, stopCompany, trackOrder } from "../trip/modes";
import { JOIN, sections } from "../../../shared/people";
import { bookLink } from "./book-ahead";
import { directionsUrl, mealSearchUrl } from "./directions";
import { genericMeal, mapsName, placeUrl } from "../core/maps-links";
import { itemLoc, stopMapsUrl } from "../geo/item-loc";
import { distKm, placeLoc, stayLoc } from "../geo/locate";
import { tipHtml } from "./tips";
import { weatherTitle, wmoIcon } from "./weather";
import { ext, icon } from "../core/icons";
import { isTransfer, onMap } from "../map/travel-day";
import { dayJourney, journeyCard, suggestedJourney } from "./journey";
import { paidByLink, shown, stopLink } from "./costs-data";

/** What was really paid per stop (Costs window), worked out once per drawing of the days. */
let paid = new Map<string, number>();
/** A stop's cost: what was really paid, highlighted (the estimate in its tooltip), or the estimate. */
function costHtml(x: ItineraryItem, d: Day, cur: string) {
  const real = paid.get(stopLink(d.date, x.place));
  if (real != null) return `<span class="cost actual" title="${esc(`Really paid${x.cost ? ` · estimated ${shown(x.cost, cur)}` : ""}`)}">${icon("check")}${shown(real, cur)}</span>`;
  // The planner's guess, which nothing here can check: marked as such.
  return x.cost ? `<span class="cost est" title="The planner's estimate: not checked, so prices may differ. Note what you really paid in Costs.">~${shown(x.cost, cur)}</span>` : "";
}
/** A day's cost: what was paid where it's known and the estimate for the rest; null when nothing's paid that day. */
function dayActual(d: Day) {
  let any = false, total = 0;
  for (const x of d.items) { const real = paid.get(stopLink(d.date, x.place)); if (real != null) any = true; total += real ?? (Number(x.cost) || 0); }
  return any ? total : null;
}

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
  const transfer = isTransfer(x), where = onMap(x, d) ? itemLoc(x, d, byTitle) : null;
  const pinGuess = !transfer && !x.pinned && (!where || !!where.approx);
  const pinTitle = transfer ? (x.pinned || where ? "Change where this leg ends on the map" : "Set where this leg ends, to draw it on the map (like the foot of the mountain)")
    : pinGuess ? "The location is only estimated: set where it really is" : "Set where this stop is";
  return `
    <li class="item${must ? " must" : listed ? " listed" : ""}" data-k="${di}-${xi}">
      <div class="item-top">
        <time>${esc(fmtTime(x.time))}</time>
        <span class="n" draggable="true" data-drag="${di}-${xi}" title="Drag onto another day to move this stop there">${xi + 1}</span>
        <span class="name"><a href="${esc(mapsLink(x, d, di, xi, byTitle))}" target="_blank" rel="noopener"${transfer && x.transportWas !== undefined ? ` title="The line is from the timetable. The plan said: ${esc(x.transportWas)}"` : ""}>${transfer && x.transportWas !== undefined ? `<span class="from-timetable">${icon("clock")}</span>` : ""}${esc(x.place)}</a>${must ? `<span class="must-tag" title="One of your must-sees">${icon("star")} must-see</span>` : ""}${badge}</span>
        ${costHtml(x, d, cur)}
        <span class="item-acts">
        <button class="pin" data-stop-edit="${di}-${xi}" title="Edit everything about this stop: time, name, description, cost, booking, how you get here">${icon("pencil")}</button>
        ${where ? `<button class="pin${x.leg ? " set" : ""}" data-leg-edit="${di}-${xi}" title="${x.leg ? "How you get here is set by hand: change it" : "How you get here: walk, road, train, boat, places on the way"}">${icon("route")}</button>` : ""}
        ${where ? `<button class="pin show-on-map" data-show="${di}-${xi}" title="Show on the map">${icon("pin")}</button>` : ""}
        <button class="pin${pinGuess ? " guess" : ""}" data-pin="${di}-${xi}" title="${pinTitle}">${icon("crosshair")}</button>
        <button class="del" data-del="${di}-${xi}" title="Remove this stop">${icon("x")}</button>
        </span>
      </div>
      ${x.description ? `<div class="desc">${esc(x.description)}</div>` : ""}
      ${x.transport || links ? `<div class="transport"${!transfer && x.transportWas !== undefined ? ` title="From the timetable. The plan said: ${esc(x.transportWas || "(nothing)")}"` : ""}>${!transfer && x.transportWas !== undefined ? `<span class="from-timetable">${icon("clock")}</span>` : ""}${esc(x.transport || "")}${links ? `<span class="t-links">${x.transport ? " · " : ""}${links}</span>` : ""}</div>` : ""}
      <div class="leg" data-leg="${di}-${xi}"></div>
      <div class="far-warn" data-far="${di}-${xi}" hidden></div>
      <div class="far-warn" data-hours="${di}-${xi}" hidden></div>
      <div class="far-warn dup-warn" data-dup="${di}-${xi}" hidden></div>
    </li>`;
}

/** Consecutive items with a group label form one fork: a column per subgroup, side by side. */
function dayItemsHtml(d: Day, di: number, byTitle: ByTitle, cur: string, trackColor: Record<string, number>) {
  const item = (x: ItineraryItem, i: number) => itemHtml(d, di, x, i, byTitle, cur);
  let out = "", run: { x: ItineraryItem; i: number }[] = [], forks = 0;
  /** The split's tabs and columns (split-tabs.ts shows one or the other); `main` opens first. */
  const splitBox = (key: string, groups: string[], main: string, size: (g: string) => number, cols: string, nest: boolean) => {
    const tab = (g: string) => `<button type="button" role="tab" class="split-tab t${trackColor[g] ?? 0}" data-split-tab="${esc(g)}">${esc(g)}<span>${size(g)}</span></button>`;
    return `<div class="split" data-split="${esc(key)}" data-main="${esc(main)}"><div class="split-tabs" role="tablist">${groups.map(tab).join("")}</div><div class="tracks${nest ? " nest" : ""}">${cols}</div></div>`;
  };
  const busiest = (groups: string[], size: (g: string) => number) => groups.reduce((a, b) => (size(b) > size(a) ? b : a), groups[0]);
  /** Who does what, by name: a split for each time people are apart, the meet-ups between them. */
  const flushWho = () => {
    const xs = run.map((r) => r.x);
    for (const s of sections(xs, stopCompany)) {
      if (!("fork" in s)) continue; // (everyone's stops aren't in the run)
      const id = `${di}-${forks++}`, { cols, meanwhile } = s.fork;
      const labels = cols.map((c) => c.who.join(JOIN)), size = (g: string) => cols[labels.indexOf(g)].items.length;
      for (const g of labels) trackColor[g] ??= Object.keys(trackColor).length % 4;
      const col = (c: (typeof cols)[number], k: number) => {
        const slim = c.items.length <= 2 && cols.some((o) => o.items.length > 2);
        return `<div class="track t${trackColor[labels[k]]}${slim ? " slim" : ""}" data-g="${esc(labels[k])}">
          <div class="track-head">${esc(labels[k])}<span>${icon("users")} ${c.who.length}</span></div>
          <ul class="items">${c.items.map((j) => item(run[j].x, run[j].i)).join("")}</ul></div>`;
      };
      const still = meanwhile.map((m) => `<li><b>${esc(m.who.join(JOIN))}</b>: ${esc(xs[m.item].place)} <span>(since ${esc(fmtTime(xs[m.item].time))})</span></li>`).join("");
      out += `<li class="fork"><div class="fork-label">${cols.length > 1 ? "Group splits up" : "Some of the group"}</div>${splitBox(id, labels, busiest(labels, size), size, cols.map(col).join(""), false)}${still ? `<ul class="meanwhile">${still}</ul>` : ""}</li>`;
    }
    run = [];
  };
  const flush = () => {
    if (!run.length) return;
    if (byWho(d.items)) return flushWho();
    const tracks = new Map<string, typeof run>();
    for (const r of run) { const g = splitGroup(r.x); if (!tracks.has(g)) tracks.set(g, []); tracks.get(g)!.push(r); }
    // A group that splits again later ("Group B" into "Group B1", "B2"…): its new groups side by side inside its own
    // column, under its stops, so the plan reads as it happened.
    const labels = new Set(tracks.keys());
    const order = trackOrder(run.map((r) => r.x));
    const kids = (p: string) => order.filter((g) => parentGroup(g, labels) === p);
    const leaves = (g: string): number => kids(g).reduce((n, k) => n + leaves(k), 0) || 1;
    const nested = order.some((g) => parentGroup(g, labels));
    // Nested: each column as wide as the groups it ends up as (a group of three that splits in three gets three widths).
    const id = `${di}-${forks++}`;
    /** All the stops a group does, with the groups it splits into. */
    const size = (g: string): number => (tracks.get(g)?.length || 0) + kids(g).reduce((n, k) => n + size(k), 0);
    const col = (label: string, parent: string, siblings: string[]): string => {
      const rs = tracks.get(label) || [];
      trackColor[label] ??= Object.keys(trackColor).length % 4;
      const people = rs.find((r) => r.x.people)?.x.people, sub = kids(label);
      // A group with a stop or two (resting at the hotel) next to a busier one: a slim column.
      const slim = !sub.length && rs.length <= 2 && siblings.some((g) => size(g) > 2);
      return `<div class="track t${trackColor[label]}${slim ? " slim" : ""}" data-g="${esc(label)}"${nested ? ` style="flex: ${leaves(label)} 1 ${leaves(label) * 190}px"` : ""}>
        <div class="track-head">${esc(label)}${people ? `<span>${icon("users")} ${people}</span>` : ""}</div>
        ${rs.length ? `<ul class="items">${rs.map((r) => item(r.x, r.i)).join("")}</ul>` : ""}
        ${sub.length ? `<div class="fork-label sub">Then splits up</div>${splitHtml(`${parent}/${label}`, sub, true)}` : ""}
      </div>`;
    };
    /** The groups side by side, with their tabs for when there's no room (split-tabs.ts). The busiest opens first. */
    const splitHtml = (key: string, groups: string[], nest: boolean): string =>
      splitBox(key, groups, busiest(groups, size), size, groups.map((g) => col(g, key, groups)).join(""), nest);
    for (const g of order) trackColor[g] ??= Object.keys(trackColor).length % 4;
    out += `<li class="fork"><div class="fork-label">Group splits up</div>${splitHtml(id, kids(""), nested)}</li>`;
    run = [];
  };
  // A travel day: its rides as one journey card (or, with none, the stays' way between the towns, offered to add).
  const journey = dayJourney(d);
  if (journey && !journey.runs.length) out += suggestedJourney(di, journey);
  d.items.forEach((x, i) => {
    if (journey?.start.has(i)) {
      flush();
      const k = journey.start.get(i)!;
      out += journeyCard(d, journey, k, journey.runs[k].items.map((xi) => item(d.items[xi], xi)).join(""), cur);
    } else if (journey?.inRun.has(i)) return;
    else if (splitGroup(x)) run.push({ x, i });
    else { flush(); out += item(x, i); }
  });
  flush();
  return out;
}

export function daysHtml(it: Itinerary, byTitle: ByTitle, cur: string, budget: number) {
  refreshMustSees();
  paid = paidByLink();
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
          <span class="edit-slot" data-edit="${esc(dayKey(it.days, i))}">${editChip(dayKey(it.days, i))}</span>
          ${w ? `<span class="weather${w.kind === "typical" ? " typical" : w.kind === "was" ? " was" : ""}" title="${esc(weatherTitle(w))}">${wmoIcon(w.code)}${w.kind === "typical" ? "~" : ""}${fmtTemps(w.min, w.max)}</span>` : ""}
          ${((real) => real == null
            ? `<span class="budget-pill ${d.estimatedCost > budget ? "over" : ""}" title="The planner's estimate for the day${d.estimatedCost > budget ? ", over the budget" : ""}: not checked">${shown(d.estimatedCost, cur)}</span>`
            : `<span class="budget-pill actual${real > budget ? " over" : ""}" title="${esc(`What was really paid where it's known, the estimate for the rest (estimated ${shown(d.estimatedCost, cur)})`)}">${icon("check")}${shown(real, cur)}</span>`)(dayActual(d))}
          ${it.days.length > 1 ? `<button class="redo" data-swap="${i}" title="Swap this day with another day (the dates stay)">${icon("arrowLeftRight")}</button>` : ""}
          <button class="redo" data-redo="${i}" title="Re-plan this day (keeps the other days)">${icon("refresh")}</button>
        </span>
      </div>
      <ul class="items">${dayItemsHtml(d, i, byTitle, cur, trackColor)}</ul>
      ${addStopHtml(i, !d.items.length)}
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
    : billing === "free" ? `by ${esc(meta.engine)}, on your key's free tier (no charge; counts toward its daily limit)`
    : `${meta.engine ? `by ${esc(meta.engine)}` : "via Claude Code"} (counts toward your Claude plan usage, no API charges)`}</p>`;
  return html;
}
