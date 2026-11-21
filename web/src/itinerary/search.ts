// The search box above the days: shows only the stops (and days) matching every word typed, e.g. "castle" or
// "train salzburg". Matches stops' places, descriptions and transport, and days' towns, titles and dates, ignoring accents.
import type { Day, ItineraryItem } from "../../../shared/types";
import { $, $$, esc } from "../core/dom";
import { session, state } from "../core/state";

const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const itemText = (x: ItineraryItem) => norm([x.place, x.description, x.transport, x.group, x.kind, x.bookAhead].join(" "));
// Not the day's notes: they mention many places, so too many whole days would match.
const dayText = (d: Day) => norm([d.date, d.city, d.title].join(" "));

export const searchHtml = () => `<div class="it-search">
  <input type="search" id="itSearch" placeholder="Search the itinerary: places, notes, transport… (press /)" value="${esc(session.search)}" autocomplete="off">
  <span class="hint" id="itSearchCount"></span>
</div>`;

/** Hides what doesn't match the search (everything shows again when it's empty). */
export function applySearch() {
  const it = state.itinerary; if (!it) return;
  const words = norm(session.search).split(/\s+/).filter(Boolean);
  const all = (text: string) => words.every((w) => text.includes(w));
  let stops = 0, days = 0;
  it.days.forEach((d, di) => {
    const dayEl = $(`#day-${di}`); if (!dayEl) return;
    const hits = d.items.map((x) => words.length > 0 && all(itemText(x)));
    // The day itself matches (its town, title, date or notes) and none of its stops do: show the whole day.
    const wholeDay = words.length > 0 && !hits.some(Boolean) && all(dayText(d));
    let shown = 0;
    d.items.forEach((_, xi) => {
      const el = $(`.item[data-k="${di}-${xi}"]`); if (!el) return;
      const hit = hits[xi];
      const show = !words.length || hit || wholeDay;
      el.hidden = !show;
      el.classList.toggle("search-hit", hit);
      if (show) shown++;
      if (hit) stops++;
    });
    // A split-up part of the day with nothing left to show goes too.
    for (const fork of $$(".fork", dayEl)) fork.hidden = !$$(".item", fork).some((el) => !el.hidden);
    dayEl.hidden = words.length > 0 && !shown;
    if (!dayEl.hidden && words.length) days++;
  });
  // A town heading goes when none of its days are left.
  for (const band of $$(".city-band")) {
    let el = band.nextElementSibling as HTMLElement | null, any = false;
    while (el && !el.classList.contains("city-band")) {
      if (el.classList.contains("day") && !el.hidden) any = true;
      el = el.nextElementSibling as HTMLElement | null;
    }
    band.hidden = !any;
  }
  const count = $("#itSearchCount");
  if (count) count.textContent = !words.length ? "" : days ? `${stops} stop${stops === 1 ? "" : "s"} on ${days} day${days === 1 ? "" : "s"}` : "Nothing matches";
}

export function wireSearch() {
  const input = $<HTMLInputElement>("#itSearch"); if (!input) return;
  input.oninput = () => { session.search = input.value; applySearch(); };
  input.onkeydown = (e) => { if (e.key === "Escape") { input.value = session.search = ""; applySearch(); } };
  applySearch();
}

/** "/" jumps to the search box (unless you're typing somewhere). */
export function initSearchKey() {
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== "/" || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
    const input = $<HTMLInputElement>("#itSearch");
    if (input) { e.preventDefault(); input.focus(); input.select(); }
  });
}
