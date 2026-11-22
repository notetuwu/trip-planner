// Getting the plan ready for printing (Print / PDF, or Ctrl+P): a cover with the trip and its stays, booking, holidays
// and packing moved after the days and opened, the light colours, and the trip's name in the page margins (in place of
// the browser's URL and date). Afterwards the plan is drawn again as it was.
import { esc } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { state } from "../core/state";
import { renderItinerary } from "../itinerary/render";

let theme: string | undefined, prepared = false;

function cover() {
  const stays = state.stays.filter((s) => s.city);
  const it = state.itinerary;
  const name = document.querySelector("#tripTitle h1")?.textContent?.trim() || it?.destination || "Trip";
  const first = stays[0]?.start, last = stays.at(-1);
  const end = first && last?.start ? addDays(last.start, last.nights) : "";
  const nights = stays.reduce((n, s) => n + (+s.nights || 0), 0);
  const line = [first && end ? `${fmtDate(first)} – ${fmtDate(end)}` : "", nights ? `${nights} nights` : "", `${state.travelers} traveler${state.travelers > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  const rows = stays.map((s) => {
    const trips = (s.dayTrips || []).map((d) => d.place).filter(Boolean).join(", ");
    return `<tr><td><b>${esc(s.city)}</b>${s.hotel ? `<br><small>${esc(s.hotel)}</small>` : ""}</td>
      <td>${s.start ? `${esc(fmtDate(s.start))} – ${esc(fmtDate(addDays(s.start, s.nights)))}` : ""}</td><td>${s.nights}</td><td>${esc(s.travel || "")}</td><td>${esc(trips)}</td></tr>`;
  }).join("");
  return { name, html: `<section class="print-cover">
    <h1>${esc(name)}</h1>
    <p class="pc-line">${esc(line)}</p>
    ${rows ? `<table><thead><tr><th>Stay</th><th>Dates</th><th>Nights</th><th>Getting there</th><th>Day trips</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    ${it?.summary ? `<p class="pc-summary">${esc(it.summary)}</p>` : ""}
  </section>` };
}

let watcher: MutationObserver | null = null;

function before() {
  const out = document.getElementById("output");
  if (!out || !state.itinerary || prepared) return;
  prepared = true;
  // Light colours on paper, whatever the screen uses.
  theme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = "light";
  layout(out);
  // Routes, weather or lookups coming in redraw the plan: lay it out for print again.
  watcher = new MutationObserver(() => { if (prepared && !out.querySelector(".print-cover") && out.querySelector(".day")) layout(out); });
  watcher.observe(out, { childList: true });
}

/** The cover first, then the days, then booking, holidays, packing, tips and what didn't fit. */
function layout(out: HTMLElement) {
  const { name, html } = cover();
  out.insertAdjacentHTML("afterbegin", html);
  // Booking, holidays and packing after the days, opened; then tips and what didn't fit.
  const after = document.createElement("section");
  after.className = "print-after";
  for (const sel of [".book-ahead", ".events", ".packing"]) {
    const d = out.querySelector<HTMLDetailsElement>(`details${sel}`);
    if (d) { d.open = true; after.append(d); }
  }
  const extras = out.querySelector(".extras");
  if (extras) after.append(extras);
  if (after.childElementCount) out.append(after);
  // The trip's name in the top margin: with the page's own margin texts, the browser leaves out its URL and date.
  document.getElementById("printPage")?.remove();
  const style = document.createElement("style");
  style.id = "printPage";
  style.textContent = `@page { @top-left { content: ${JSON.stringify(name)}; font: 9pt system-ui, sans-serif; color: #777; } }`;
  document.head.append(style);
}

function after() {
  if (!prepared) return;
  prepared = false;
  watcher?.disconnect(); watcher = null;
  document.getElementById("printPage")?.remove();
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  renderItinerary();
}

export function initPrint() {
  window.addEventListener("beforeprint", before);
  window.addEventListener("afterprint", after);
}
