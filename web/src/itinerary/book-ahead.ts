// Booking: ticket links on stops that cost money to get in, and a checklist of everything worth booking before the trip.
// Websites are looked up while the page is open, so the links are refreshed in place when they arrive.
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { save, state } from "../core/state";
import { type ByTitle, byTitleMap, daySegments, stopWebsite } from "../geo/item-loc";
import { stayLoc, tripCountries } from "../geo/locate";
import { type TicketLink, bookingSite, pickWebsite, ticketLinks, ticketQuery } from "./booking-sites";
import { ext, icon } from "../core/icons";
import { modeName } from "../trip/modes";
import { bookableMode, hotelUrl, transportUrl } from "./travel-links";

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
/** Stays to book (Booking.com) and transfers to book (Rome2Rio), each with a tick box like the tickets. */
function tripRows() {
  const travelers = Number(state.travelers) || 1;
  const hotels = state.stays.filter((s) => s.city && s.start && Number(s.nights) > 0).map((s) => ({
    key: `hotel|${s.start}|${s.city}`, date: s.start, what: `Stay in ${s.city}`,
    when: `${s.nights} night${Number(s.nights) > 1 ? "s" : ""}${s.hotel ? ` · ${s.hotel}` : ""}`,
    link: { url: hotelUrl(s, travelers, stayLoc(s)), label: "Booking.com", title: `Hotels in ${s.city}, ${fmtDate(s.start)} – ${fmtDate(addDays(s.start, s.nights))}` },
  }));
  const rides = state.stays.map((s, i) => ({ s, prev: state.stays[i - 1] })).filter(({ s, prev }) => prev?.city && s.city && s.start && bookableMode(s.travel))
    .map(({ s, prev }) => ({
      key: `travel|${s.start}|${prev.city}>${s.city}`, date: s.start, what: `${prev.city} → ${s.city}`,
      when: s.travel ? modeName(s.travel) : "train, bus or flight",
      link: { url: transportUrl(prev.city, s.city), label: "Compare on Rome2Rio", title: `Ways to get from ${prev.city} to ${s.city}, with links to book` },
    }));
  return [...hotels, ...rides].sort((a, b) => a.date.localeCompare(b.date));
}

export function bookAheadHtml(it: Itinerary) {
  const rows = it.days.flatMap((d, di) => d.items.map((x, xi) => ({ d, x, di, xi })).filter(({ x }) => x.booking === "essential" || x.booking === "recommended"));
  const trip = tripRows();
  if (!rows.length && !trip.length) return "";
  const s = site(), booked = state.booked || {}, byTitle = byTitleMap();
  const total = rows.length + trip.length;
  const left = rows.filter(({ d, x }) => !booked[bookingKey(d, x)]).length + trip.filter((r) => !booked[r.key]).length;
  const tripHtml = trip.map((r) => `<li class="trip">
        <label><input type="checkbox" data-booked="${esc(r.key)}" ${booked[r.key] ? "checked" : ""}>
          <span class="ev-date">${esc(fmtDate(r.date))}</span>
          <b>${esc(r.what)}</b></label>
        <span class="when">${esc(r.when)}</span>
        <span class="links"><a href="${esc(r.link.url)}" target="_blank" rel="noopener" title="${esc(r.link.title)}">${esc(r.link.label)}${ext()}</a></span>
      </li>`).join("");
  return `<details class="book-ahead fold" data-fold="book-ahead">
    <summary><h2>Book ahead</h2><span class="hint">${left ? `${left} of ${total} still to book` : `all ${total} booked`} · stays, transport and tickets</span></summary>
    ${trip.length ? `<div class="ahead-sub">Stays &amp; transport</div><ul>${tripHtml}</ul>` : ""}
    ${rows.length ? `<div class="ahead-sub">Tickets <span class="hint">official sites where known, plus ${esc(s.name)}</span></div>` : ""}
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
