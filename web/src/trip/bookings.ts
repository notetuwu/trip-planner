// Things already booked (a concert, an expo, a theme park, a timed entry): name, date, an optional time or time window
// and cost. The planner plans around them, and they always end up on their day (see server/ai/output.ts).
import type { Booking } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { save, state } from "../core/state";
import { icon } from "../core/icons";
import { renderItinerary } from "../itinerary/render";

function rowHtml(b: Booking, i: number) {
  return `
    <div class="booking" data-bi="${i}">
      <div class="bk-top">
        <span class="bk-label">${icon("ticket")} Booked</span>
        <input data-bk="name" value="${esc(b.name)}" placeholder="e.g. teamLab Borderless">
        <button class="icon-btn" data-bk-del title="Remove booking">${icon("x")}</button>
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
    </div>`;
}

export function renderBookings() {
  const list = state.bookings || [];
  $("#bookings").innerHTML = list.map(rowHtml).join("") +
    `<button class="link-btn" type="button" data-bk-add>＋ Add a booking</button>${list.length ? "" : ` <span class="muted">a concert, an expo, timed tickets… planned around</span>`}`;
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
    save(); renderItinerary();
  });
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-bk-add]")) {
      (state.bookings ||= []).push({ name: "", date: state.stays[0]?.start || "", countCost: true });
      save(); renderBookings();
      box.querySelectorAll<HTMLInputElement>('[data-bk="name"]').item((state.bookings.length || 1) - 1)?.focus();
      return;
    }
    const del = t.closest<HTMLElement>("[data-bk-del]");
    if (del) { state.bookings!.splice(+del.closest<HTMLElement>(".booking")!.dataset.bi!, 1); save(); renderBookings(); }
  });
  renderBookings();
}
