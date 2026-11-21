// Booking: ticket links on stops that cost money to get in, and a checklist of everything worth booking before the trip.
// Websites are looked up while the page is open, so the links are refreshed in place when they arrive.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { save, state } from "../core/state";
import { type ByTitle, byTitleMap, daySegments, stopWebsite } from "../geo/item-loc";
import { tripCountries } from "../geo/locate";
import { type TicketLink, bookingSite, pickWebsite, ticketLinks, ticketQuery } from "./booking-sites";
import { ext, icon } from "../core/icons";

const site = () => bookingSite(tripCountries().map(([cc]) => cc));
const towns = (d: Day) => { const t = daySegments(d); return t.length ? t : [d.city]; };
const mapsUrl = (x: ItineraryItem, d: Day) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.place}, ${towns(d)[0]}`)}`;
const isMeal = (x: ItineraryItem) => x.kind === "meal" || /^(breakfast|brunch|lunch|dinner)\b/i.test(x.place);

const anchors = (links: TicketLink[], cls: string, prefix: string) => links
  .map((l) => `<a class="${cls}" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.title)}">${prefix}${esc(l.label)}${ext()}</a>`).join(" · ");

/** The ticket links on a stop in the day list ("" for free places, meals and transfers). */
function stopLinks(d: Day, x: ItineraryItem, byTitle: ByTitle) {
  return anchors(ticketLinks(x, towns(d), site(), pickWebsite(stopWebsite(x, d, byTitle), x.website)), "book", icon("ticket"));
}

/** The links in the book-ahead list: a restaurant's page to reserve, else tickets (trains and rides included). */
function aheadLinks(d: Day, x: ItineraryItem, byTitle: ByTitle) {
  if (isMeal(x)) return `<a href="${esc(mapsUrl(x, d))}" target="_blank" rel="noopener" title="Find the restaurant's phone or booking page">Reserve${ext()}</a>`;
  const website = pickWebsite(stopWebsite(x, d, byTitle), x.website);
  const links = ticketLinks(x, towns(d), site(), website);
  if (!links.length) {
    links.push(website ? { url: website, label: "Tickets / info", title: "Its own website" }
      : { url: `https://www.google.com/search?q=${encodeURIComponent(`${ticketQuery(x.place)} tickets`)}`, label: "Tickets", title: "Search for tickets" });
  }
  return anchors(links, "", "");
}

/** Ticket links for a stop in the day list, in a span that refreshLinks() can update. */
export function bookLink(x: ItineraryItem, d: Day, di: number, xi: number) {
  const html = stopLinks(d, x, byTitleMap());
  return html ? `<span data-ticket="${di}-${xi}">${html}</span>` : "";
}

export const bookingKey = (d: Day, x: ItineraryItem) => `${d.date}|${x.place}`;

/** Everything marked essential or recommended to book, in trip order, with a tick box each. */
export function bookAheadHtml(it: Itinerary) {
  const rows = it.days.flatMap((d, di) => d.items.map((x, xi) => ({ d, x, di, xi })).filter(({ x }) => x.booking === "essential" || x.booking === "recommended"));
  if (!rows.length) return "";
  const s = site(), booked = state.booked || {}, byTitle = byTitleMap();
  const left = rows.filter(({ d, x }) => !booked[bookingKey(d, x)]).length;
  return `<details class="book-ahead fold" data-fold="book-ahead">
    <summary><h2>Book ahead</h2><span class="hint">${left ? `${left} of ${rows.length} still to book` : `all ${rows.length} booked`} · official sites where known, plus ${esc(s.name)}</span></summary>
    <ul>${rows.map(({ d, x, di, xi }) => {
      const key = bookingKey(d, x);
      return `<li class="${x.booking}">
        <label><input type="checkbox" data-booked="${esc(key)}" ${booked[key] ? "checked" : ""}>
          <span class="ev-date">${esc(fmtDate(d.date) || d.date)}</span>
          <b>${esc(x.place)}</b></label>
        <span class="when">${x.booking === "essential" ? "Essential" : "Recommended"}${x.bookAhead ? ` · ${esc(x.bookAhead)}` : ""}</span>
        <span class="links" data-ahead="${di}-${xi}">${aheadLinks(d, x, byTitle)}</span>
      </li>`;
    }).join("")}</ul>
  </details>`;
}

/** Updates the ticket links in place, e.g. when a place's website has been looked up. */
export function refreshLinks() {
  const it = state.itinerary; if (!it) return;
  const byTitle = byTitleMap();
  for (const [attr, render] of [["data-ticket", stopLinks], ["data-ahead", aheadLinks]] as const) {
    for (const el of $$(`[${attr}]`)) {
      const [di, xi] = el.getAttribute(attr)!.split("-").map(Number), d = it.days[di], x = d?.items[xi];
      if (!x) continue;
      const html = render(d, x, byTitle);
      if (el.innerHTML !== html) el.innerHTML = html;
    }
  }
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
