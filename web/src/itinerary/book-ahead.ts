// Booking: a ticket link on stops that cost money to get in, and a checklist of everything worth booking before the trip.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { save, state } from "../core/state";
import { byTitleMap, daySegments, exactPoi } from "../geo/item-loc";
import { tripCountries } from "../geo/locate";
import { bookingQuery, bookingSite, ticketLink } from "./booking-sites";

const site = () => bookingSite(tripCountries().map(([cc]) => cc));
/** The day's towns, without bracketed details such as an address. */
const towns = (d: Day) => {
  const t = (daySegments(d).length ? daySegments(d) : [d.city]).map((s) => s.replace(/\s*\([^)]*\)/g, "").trim()).filter(Boolean);
  return t.length ? t : [d.city];
};
const mapsUrl = (x: ItineraryItem, d: Day) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.place}, ${towns(d)[0]}`)}`;

/** The ticket link on a stop in the day list ("" for free places, meals and transfers). */
export function bookLink(x: ItineraryItem, d: Day) {
  const link = ticketLink(x, towns(d), site(), exactPoi(x, d, byTitleMap())?.website);
  return link ? `<a class="book" href="${esc(link.url)}" target="_blank" rel="noopener" title="${esc(link.title)}">🎟 ${esc(link.label)} ↗</a>` : "";
}

export const bookingKey = (d: Day, x: ItineraryItem) => `${d.date}|${x.place}`;

/** Everything marked essential or recommended to book, in trip order, with a tick box each. */
export function bookAheadHtml(it: Itinerary) {
  const rows = it.days.flatMap((d) => d.items.filter((x) => x.booking === "essential" || x.booking === "recommended").map((x) => ({ d, x })));
  if (!rows.length) return "";
  const s = site(), booked = state.booked || {};
  const left = rows.filter(({ d, x }) => !booked[bookingKey(d, x)]).length;
  const byTitle = byTitleMap();
  const link = (d: Day, x: ItineraryItem) => {
    if (x.kind === "meal" || /^(breakfast|brunch|lunch|dinner)\b/i.test(x.place)) {
      return `<a href="${esc(mapsUrl(x, d))}" target="_blank" rel="noopener" title="Find the restaurant's phone or booking page">Reserve ↗</a>`;
    }
    const t = ticketLink(x, towns(d), s, exactPoi(x, d, byTitle)?.website)
      // Trains, cable cars and the like: search for their tickets.
      || { url: `https://www.google.com/search?q=${encodeURIComponent(`${bookingQuery(x.place, "")} tickets`)}`, label: "Tickets", title: "Search for tickets" };
    return `<a href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(t.title)}">${esc(t.label)} ↗</a>`;
  };
  return `<details class="book-ahead fold" data-fold="book-ahead">
    <summary><h2>Book ahead</h2><span class="hint">${left ? `${left} of ${rows.length} still to book` : `all ${rows.length} booked`} · tickets and tours via ${esc(s.name)}</span></summary>
    <ul>${rows.map(({ d, x }) => {
      const key = bookingKey(d, x);
      return `<li class="${x.booking}">
        <label><input type="checkbox" data-booked="${esc(key)}" ${booked[key] ? "checked" : ""}>
          <span class="ev-date">${esc(fmtDate(d.date) || d.date)}</span>
          <b>${esc(x.place)}</b></label>
        <span class="when">${x.booking === "essential" ? "Essential" : "Recommended"}${x.bookAhead ? ` · ${esc(x.bookAhead)}` : ""}</span>
        ${link(d, x)}
      </li>`;
    }).join("")}</ul>
  </details>`;
}

export function wireBookAhead(root: HTMLElement) {
  for (const box of $$<HTMLInputElement>("[data-booked]", root)) {
    box.onchange = () => {
      state.booked = { ...state.booked, [box.dataset.booked!]: box.checked };
      if (!box.checked) delete state.booked[box.dataset.booked!];
      save();
    };
  }
}
