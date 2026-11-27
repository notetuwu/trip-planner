// Moving stops and days by hand, without the planner or the chat: a stop's number drags onto another day (it keeps its
// time and goes in time order there), and a day's swap button trades what two days do (the dates stay). Each has Undo.
import { $$ } from "../core/dom";
import { askChoice } from "../core/ask";
import { fmtDate } from "../core/format";
import { state } from "../core/state";
import { moveStopTo, swapDays } from "../map/edit";
import { isReadOnly } from "../saves/read-only";

const TYPE = "application/x-trip-stop";

export function wireMoves(out: HTMLElement) {
  const ro = isReadOnly();
  for (const el of $$<HTMLElement>("[data-drag]", out)) {
    el.draggable = !ro;
    if (ro) continue;
    el.ondragstart = (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(TYPE, el.dataset.drag!);
      e.dataTransfer.effectAllowed = "move";
      // The whole stop as the picture that moves along, not only its number.
      const li = el.closest<HTMLElement>(".item");
      if (li) e.dataTransfer.setDragImage(li, 16, 16);
      out.classList.add("moving-stop");
    };
    el.ondragend = () => {
      out.classList.remove("moving-stop");
      for (const d of $$(".day.drop-here", out)) d.classList.remove("drop-here");
    };
  }
  if (!ro) for (const day of $$<HTMLElement>(".day[data-i]", out)) {
    const carries = (e: DragEvent) => !!e.dataTransfer?.types.includes(TYPE);
    day.ondragover = (e) => { if (!carries(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "move"; day.classList.add("drop-here"); };
    day.ondragleave = (e) => { if (!day.contains(e.relatedTarget as Node)) day.classList.remove("drop-here"); };
    day.ondrop = (e) => {
      if (!carries(e)) return;
      e.preventDefault();
      day.classList.remove("drop-here");
      const [di, xi] = e.dataTransfer!.getData(TYPE).split("-").map(Number), to = Number(day.dataset.i);
      if (di !== to) moveStopTo(di, xi, to);
    };
  }
  for (const el of $$<HTMLButtonElement>("[data-swap]", out)) el.onclick = async (e) => {
    e.stopPropagation();
    const days = state.itinerary?.days || [], i = Number(el.dataset.swap);
    const label = (k: number) => `Day ${k + 1} · ${fmtDate(days[k].date) || days[k].date} · ${days[k].title || days[k].city}`;
    const choices = days.map((_, k) => k).filter((k) => k !== i).map((k) => ({ value: String(k), text: label(k) }));
    // The day after (or before, for the last day) is offered first: the usual swap.
    const near = String(i + 1 < days.length ? i + 1 : i - 1);
    const pick = await askChoice({ title: `Swap day ${i + 1} with…`, text: "The two days trade their stops, title and notes; the dates stay where they are. Bookings on a date don't move along.", label: "Day", choices, value: near, ok: "Swap" });
    if (pick != null) swapDays(i, Number(pick));
  };
}
