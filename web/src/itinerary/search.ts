// The search box above the days: shows only the stops (and days) matching every word typed, e.g. "castle" or
// "train salzburg". Matches stops' places, descriptions and transport, and days' numbers, towns, titles, dates and stays, ignoring accents.
import type { Day, ItineraryItem } from "../../../shared/types";
import { $, $$, esc } from "../core/dom";
import { session, state } from "../core/state";
import { addDays, fmtDate } from "../core/format";

const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");
const itemText = (x: ItineraryItem) => norm([x.place, x.description, x.transport, x.group, x.kind, x.bookAhead].join(" "));
// Not the day's notes: they mention many places, so too many whole days would match.
// Also its number ("day 3"), its date as shown ("Tue, Mar 12") and its stay (town and hotel).
const dayText = (d: Day, i: number) => {
  const s = state.stays.find((s) => s.start && Number(s.nights) > 0 && d.date >= s.start && d.date < addDays(s.start, Number(s.nights)));
  return norm([d.date, fmtDate(d.date), d.city, d.title, s?.city, s?.hotel].join(" "));
};

export const searchHtml = () => `<div class="it-search">
  <input type="search" id="itSearch" placeholder="Search the itinerary: places, days, stays, transport… (press /)" value="${esc(session.search)}" autocomplete="off">
  <span class="hint" id="itSearchCount"></span>
</div>`;

/** Hides what doesn't match the search (everything shows again when it's empty). */
export function applySearch() {
  const it = state.itinerary; if (!it) return;
  let q = norm(session.search);
  // "day 9" is the ninth day exactly, not the words "day" and "9" (which any date like the 19th would match).
  const dayNo = new Set<number>();
  q = q.replace(/\bday\s*(\d+)\b/g, (_, n) => { dayNo.add(Number(n)); return " "; });
  const words = q.split(/\s+/).filter(Boolean);
  const active = words.length > 0 || dayNo.size > 0;
  const all = (text: string) => words.every((w) => text.includes(w));
  let stops = 0, days = 0;
  it.days.forEach((d, di) => {
    const dayEl = $(`#day-${di}`); if (!dayEl) return;
    const dayOk = !dayNo.size || dayNo.has(di + 1);
    const hits = d.items.map((x) => dayOk && words.length > 0 && all(itemText(x)));
    // The day itself matches (its number, town, title, date or stay): show the whole day, even if some stops happen to
    // match the words too (a "day trip" at "9:00" must not hide day 9's other stops).
    const wholeDay = active && dayOk && all(dayText(d, di));
    let shown = 0;
    d.items.forEach((_, xi) => {
      const el = $(`.item[data-k="${di}-${xi}"]`); if (!el) return;
      const hit = hits[xi] && !wholeDay;
      const show = !active || hit || wholeDay;
      el.hidden = !show;
      el.classList.toggle("search-hit", hit);
      if (show) shown++;
      if (hit || wholeDay) stops++;
    });
    // A split-up part of the day with nothing left to show goes too.
    for (const fork of $$(".fork", dayEl)) fork.hidden = !$$(".item", fork).some((el) => !el.hidden);
    dayEl.hidden = active && !shown;
    if (!dayEl.hidden && active) days++;
  });
  // A stay's heading (and its group) goes when none of its days are left.
  for (const group of $$(".stay-group")) group.hidden = active && !$$(".day", group).some((el) => !el.hidden);
  const count = $("#itSearchCount");
  if (count) count.textContent = !active ? "" : days ? `${stops} stop${stops === 1 ? "" : "s"} on ${days} day${days === 1 ? "" : "s"}` : "Nothing matches";
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
