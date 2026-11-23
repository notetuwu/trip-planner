// Things already booked (a concert, an expo, a theme park, a timed entry): name, date, an optional time or time window
// and cost. The planner plans around them, and they always end up on their day (see server/ai/output.ts).
import type { Booking } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { fmtShort, fmtTime, money } from "../core/format";
import { save, state } from "../core/state";
import { icon } from "../core/icons";
import { renderItinerary } from "../itinerary/render";

/** Which booking's editor is open (a new one opens by itself). */
let openRow = -1;

/** One line per booking ("teamLab Borderless · 14 Nov 10:30 · €120"), opening into its editor. */
function renderLine(b: Booking) {
  const when = [b.date ? fmtShort(b.date) : "", b.from ? `${fmtTime(b.from)}${b.to ? `–${fmtTime(b.to)}` : ""}` : ""].filter(Boolean).join(" ");
  const cost = b.cost != null ? `${money(b.cost, state.currency)}${b.countCost ? "" : " paid"}` : "";
  return `${icon("ticket")}<b>${esc(b.name || "New booking")}</b><span class="bk-when">${esc([when, cost].filter(Boolean).join(" · "))}</span>`;
}

function rowHtml(b: Booking, i: number) {
  return `
    <details class="booking" data-bi="${i}"${i === openRow ? " open" : ""}>
      <summary>${renderLine(b)}</summary>
      <div class="bk-top">
        <input data-bk="name" value="${esc(b.name)}" placeholder="e.g. teamLab Borderless">
        <button class="icon-btn" data-bk-del title="Remove booking">${icon("trash")}</button>
      </div>
      <div class="bk-opts">
        <input type="date" data-bk="date" value="${esc(b.date)}" title="The day">
        <input type="time" data-bk="from" value="${esc(b.from || "")}" title="From (leave empty if any time that day)">
        <span class="muted">–</span>
        <input type="time" data-bk="to" value="${esc(b.to || "")}" title="Until (optional)">
      </div>
      <div class="bk-opts">
        <input type="number" min="0" step="any" data-bk="cost" value="${b.cost ?? ""}" placeholder="Cost (${esc(state.currency)}, whole group)" title="What it costs the whole group">
        <label class="inline-check" title="Count the cost in that day's budget (off: already paid, shown as 0)"><input type="checkbox" data-bk="countCost"${b.countCost ? " checked" : ""}> in the day's cost</label>
      </div>
    </details>`;
}

export function renderBookings() {
  const list = state.bookings || [];
  // Empty: the same kind of card as "Add places", so it's clear there's something to add here.
  $("#bookings").innerHTML = list.length
    ? list.map(rowHtml).join("") + `<button class="link-btn" type="button" data-bk-add>${icon("plus")} Add a booking</button>`
    : `<button type="button" class="list-empty" data-bk-add>${icon("plus")}<span><b>Add bookings</b><br><span class="hint">Tickets you already have (a concert, an expo, a timed entry): the plan is built around them.</span></span></button>`;
}

export function initBookings() {
  const box = $("#bookings");
  box.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement, k = el.dataset.bk as keyof Booking | undefined;
    const row = el.closest<HTMLElement>(".booking");
    if (!k || !row) return;
    const b = state.bookings![+row.dataset.bi!];
    if (k === "countCost") b.countCost = el.checked;
    else if (k === "cost") b.cost = el.value === "" ? undefined : Math.max(0, Number(el.value));
    else (b as unknown as Record<string, string>)[k] = el.value.trim();
    openRow = +row.dataset.bi!;
    save(); renderItinerary();
    // The summary line shows the new values (without closing the editor).
    const line = renderLine(b);
    row.querySelector("summary")!.innerHTML = line;
  });
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-bk-add]")) {
      (state.bookings ||= []).push({ name: "", date: state.stays[0]?.start || "", countCost: true });
      openRow = state.bookings.length - 1;
      save(); renderBookings();
      box.querySelectorAll<HTMLInputElement>('[data-bk="name"]').item((state.bookings.length || 1) - 1)?.focus();
      return;
    }
    const del = t.closest<HTMLElement>("[data-bk-del]");
    if (del) { state.bookings!.splice(+del.closest<HTMLElement>(".booking")!.dataset.bi!, 1); openRow = -1; save(); renderBookings(); }
  });
  renderBookings();
}
