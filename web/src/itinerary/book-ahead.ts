// Booking: a "Book" link on stops with tickets or tours, and a checklist of everything worth booking before the trip.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { save, state } from "../core/state";
import { daySegments } from "../geo/item-loc";
import { tripCountries } from "../geo/locate";
import { bookableOnSite, bookingQuery, bookingSite } from "./booking-sites";

const site = () => bookingSite(tripCountries().map(([cc]) => cc));
const town = (d: Day) => daySegments(d)[0] || d.city;
const mapsUrl = (x: ItineraryItem, d: Day) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.place}, ${town(d)}`)}`;

/** The link on a stop in the day list ("" when there's nothing to book on the platform). */
export function bookLink(x: ItineraryItem, d: Day) {
  if (!bookableOnSite(x)) return "";
  const s = site();
  return `<a class="book" href="${esc(s.search(bookingQuery(x.place, town(d))))}" target="_blank" rel="noopener" title="Find tickets on ${esc(s.name)}">🎟 ${esc(s.name)} ↗</a>`;
}

export const bookingKey = (d: Day, x: ItineraryItem) => `${d.date}|${x.place}`;

/** Everything marked essential or recommended to book, in trip order, with a tick box each. */
export function bookAheadHtml(it: Itinerary) {
  const rows = it.days.flatMap((d) => d.items.filter((x) => x.booking === "essential" || x.booking === "recommended").map((x) => ({ d, x })));
  if (!rows.length) return "";
  const s = site(), booked = state.booked || {};
  const left = rows.filter(({ d, x }) => !booked[bookingKey(d, x)]).length;
  const link = (d: Day, x: ItineraryItem) => bookableOnSite(x)
    ? `<a href="${esc(s.search(bookingQuery(x.place, town(d))))}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>`
    : x.kind === "meal" || /^(breakfast|brunch|lunch|dinner)\b/i.test(x.place)
      ? `<a href="${esc(mapsUrl(x, d))}" target="_blank" rel="noopener" title="Find the restaurant's phone or booking page">Reserve ↗</a>`
      : "";
  return `<details class="book-ahead" ${left ? "open" : ""}>
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
