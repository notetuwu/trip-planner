// The timeline down the right of the photo gallery, like Google Photos': a row for each day, as tall as its share of the
// photos, with a mark where the gallery is scrolled to. Click a day to jump to it, or drag along it to run through them.
import { esc } from "../core/dom";

export type TimelineDay = {
  /** On the line itself: "Day 3". */ label: string;
  /** In the bubble beside the pointer: the day in full, then its town and how many photos. */ title: string;
  sub: string;
  /** Its part of the gallery. */ el: HTMLElement;
};

/** A row's least height (less when there are more days than fit), and the room a label takes. */
const ROW = 18, LABEL = 15;

/** How tall each row is: every one at least `ROW` (if they all fit), the rest shared by how much each day shows. */
export function rowHeights(sizes: number[], height: number) {
  const least = Math.min(ROW, height / sizes.length), rest = height - least * sizes.length;
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => least + rest * (total ? s / total : 1 / sizes.length));
}

/** The same place in the other measure: `from[i]` is where part i starts in one (the last entry: where it ends), `to` in
 *  the other. Straight within a part, held at the ends. */
export function across(v: number, from: number[], to: number[]) {
  const last = from.length - 1;
  if (v <= from[0]) return to[0];
  if (v >= from[last]) return to[last];
  let i = 0;
  while (v >= from[i + 1]) i++;
  return to[i] + (to[i + 1] - to[i]) * ((v - from[i]) / (from[i + 1] - from[i]));
}

export function photoTimeline(nav: HTMLElement, scroller: HTMLElement) {
  let days: TimelineDay[] = [];
  /** Where each day starts, and the last one ends: in the gallery's scrolling and down the line. */
  let at: number[] = [], ys: number[] = [];
  let dragging = false;
  nav.innerHTML = `<div class="pt-rows"></div><i class="pt-now"></i><div class="pt-tip" hidden></div>`;
  const rows = nav.querySelector<HTMLElement>(".pt-rows")!, now = nav.querySelector<HTMLElement>(".pt-now")!, tip = nav.querySelector<HTMLElement>(".pt-tip")!;

  /** The day a point of the line is in. */
  const dayAt = (y: number) => Math.max(0, ys.findLastIndex((start, i) => i < days.length && start <= y));

  function mark() {
    if (nav.hidden || !at.length) return;
    const y = across(scroller.scrollTop, at, ys), i = dayAt(y);
    now.style.top = `${rows.offsetTop + y}px`;
    rows.querySelectorAll("button").forEach((b, n) => b.classList.toggle("on", n === i));
  }

  function layout() {
    const height = rows.clientHeight;
    if (nav.hidden || !height) return;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const boxes = days.map((d) => d.el.getBoundingClientRect());
    // A little above the heading. The last day ends with its pictures, not with the room left under them.
    at = boxes.map((b) => Math.max(0, b.top - base - 6));
    const end = days.at(-1)!.el.lastElementChild!.getBoundingClientRect().bottom - base;
    at.push(Math.max(end, at.at(-1)! + 1));
    const hs = rowHeights(at.slice(1).map((v, i) => v - at[i]), height);
    ys = hs.reduce((out, h) => [...out, out.at(-1)! + h], [0]);
    // A label where there's room for it below the one before.
    let free = 0;
    rows.querySelectorAll<HTMLElement>("button").forEach((b, i) => {
      b.style.top = `${ys[i]}px`;
      b.style.height = `${hs[i]}px`;
      const room = ys[i] >= free - 0.5;
      b.classList.toggle("bare", !room);
      if (room) free = ys[i] + LABEL;
    });
    mark();
  }

  function showTip(y: number) {
    const d = days[dayAt(y)];
    tip.innerHTML = `<b>${esc(d.title)}</b>${d.sub ? `<span>${esc(d.sub)}</span>` : ""}`;
    tip.hidden = false;
    const half = tip.offsetHeight / 2;
    tip.style.top = `${rows.offsetTop + Math.min(Math.max(y, half), rows.clientHeight - half)}px`;
  }

  const pointY = (e: PointerEvent) => Math.min(Math.max(e.clientY - rows.getBoundingClientRect().top, 0), rows.clientHeight - 1);

  nav.onpointerdown = (e) => {
    if (e.button || !at.length) return;
    e.preventDefault();
    nav.setPointerCapture(e.pointerId);
    dragging = true;
    const y = pointY(e);
    // A click goes to the start of the day; moving on from there runs through the photos.
    scroller.scrollTop = at[dayAt(y)];
    showTip(y);
  };
  nav.onpointermove = (e) => {
    if (!at.length) return;
    const y = pointY(e);
    if (dragging) scroller.scrollTop = across(y, ys, at);
    showTip(y);
  };
  nav.onpointerup = nav.onpointercancel = (e) => { dragging = false; if (e.pointerType !== "mouse") tip.hidden = true; };
  nav.onpointerleave = () => { if (!dragging) tip.hidden = true; };
  nav.onwheel = (e) => { scroller.scrollTop += e.deltaY; };
  scroller.addEventListener("scroll", mark, { passive: true });
  // The window filled or not, the sidebar hidden: the days are other heights then.
  const sizes = new ResizeObserver(layout);
  sizes.observe(scroller);
  sizes.observe(nav);

  /** The gallery was drawn again. With fewer than two days there's nowhere to jump, so no timeline. */
  return function set(list: TimelineDay[]) {
    days = list;
    at = []; ys = [];
    tip.hidden = true;
    nav.hidden = list.length < 2;
    scroller.classList.toggle("timed", !nav.hidden);
    rows.innerHTML = list.map((d) => `<button type="button" aria-label="${esc([d.title, d.sub].filter(Boolean).join(", "))}"><span>${esc(d.label)}</span></button>`).join("");
    // From the keyboard (the pointer is handled above).
    rows.querySelectorAll("button").forEach((b, i) => { b.onclick = (e) => { if (!e.detail && at.length) scroller.scrollTop = at[i]; }; });
    layout();
  };
}
