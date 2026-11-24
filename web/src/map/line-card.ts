// The card for a transport stop and its lines (top right of the map), like Google Maps': clicking a stop's icon lists
// the lines calling there; clicking a line lists all its stops in order (from OpenStreetMap, fetched once and kept),
// marks them on the map, and moves the map to any stop clicked. A line running both ways can be shown either way.
import * as L from "leaflet";
import { api, esc } from "../core/dom";
import { icon } from "../core/icons";
import type { Line } from "./transit-lines";
import { LINE_KINDS } from "./transit-lines";

interface RouteStops { id: number; name: string; ref: string; colour?: string; stops: { name: string; lat: number; lng: number }[] }
type LineAt = { line: Line; colour: string };

let m: L.Map | null = null, box: HTMLElement, marks: L.LayerGroup;
/** What the card shows, so "Back" can return to the stop. */
let atStop: { name: string; at: [number, number]; lines: LineAt[] } | null = null;

const kindOf = (l: Line) => LINE_KINDS.find((k) => k.k === l.k)!;
/** "5", "Kriens => Luzern" from "5 · Kriens => Luzern". */
const split = (n: string): [string, string] => (n.includes(" · ") ? (n.split(" · ", 2) as [string, string]) : /^\S{1,5}$/.test(n) ? [n, ""] : ["", n]);
const chip = (ref: string, colour: string) => (ref ? `<span class="line-chip" style="--c:${colour}">${esc(ref)}</span>` : "");

function close() {
  box.hidden = true; box.innerHTML = ""; atStop = null;
  marks.clearLayers();
}

function frame(head: string, body: string) {
  box.hidden = false;
  box.innerHTML = `<div class="lc-head">${head}<button type="button" class="icon-btn" data-lc-close title="Close">${icon("x")}</button></div><div class="lc-body">${body}</div>`;
  box.querySelector<HTMLButtonElement>("[data-lc-close]")!.onclick = close;
}

/** A stop's card: its name and the lines calling there (each opens the line's stops). */
export function openStop(name: string, at: [number, number], lines: LineAt[]) {
  atStop = { name, at, lines };
  marks.clearLayers();
  // Each line once (a stop can list a line's variants), numbers in order.
  const seen = new Set<string>(), list = lines.filter((x) => { const k = `${x.line.k}|${x.line.n}`; return seen.has(k) ? false : (seen.add(k), true); })
    .sort((a, b) => split(a.line.n)[0].localeCompare(split(b.line.n)[0], undefined, { numeric: true }));
  frame(`<div><b>${esc(name || "Stop")}</b><span class="hint">${list.length} line${list.length === 1 ? "" : "s"} stop here</span></div>`,
    `<ul class="lc-lines">${list.map((x, i) => {
      const [ref, rest] = split(x.line.n), k = kindOf(x.line);
      return `<li><button type="button" data-line="${i}" ${x.line.r?.length ? "" : "disabled"} title="${x.line.r?.length ? "Show all its stops" : "No stop list for this line"}">
        <i class="lc-kind" style="--c:${k.colour}">${icon(k.ic)}</i>${chip(ref, x.colour)}<span>${esc(rest || (ref ? "" : x.line.n || k.name))}</span></button></li>`;
    }).join("")}</ul>`);
  box.querySelectorAll<HTMLButtonElement>("[data-line]").forEach((b) => { b.onclick = () => openLine(list[+b.dataset.line!], 0); });
}

/** A line's card: all its stops in order (the stop it was opened from marked), each moving the map there. */
async function openLine(x: LineAt, dir: number) {
  const ids = x.line.r || [], [ref, rest] = split(x.line.n), k = kindOf(x.line);
  const head = `<div class="lc-title"><i class="lc-kind" style="--c:${k.colour}">${icon(k.ic)}</i>${chip(ref, x.colour)}<b>${esc(rest || x.line.n || k.name)}</b></div>`;
  frame(head, `<p class="hint">Loading the line's stops…</p>`);
  let route: RouteStops;
  try { route = await api<RouteStops>(`/api/lines/route?id=${ids[dir]}`); } catch (e) {
    frame(head, `<p class="hint">${esc((e as Error).message)}</p>${atStop ? `<button type="button" class="link-btn" data-back>Back to ${esc(atStop.name || "the stop")}</button>` : ""}`);
    box.querySelector<HTMLButtonElement>("[data-back]")?.addEventListener("click", () => atStop && openStop(atStop.name, atStop.at, atStop.lines));
    return;
  }
  const colour = x.colour, here = atStop?.name || "";
  const first = route.stops[0]?.name, last = route.stops[route.stops.length - 1]?.name;
  frame(head, `
    <div class="lc-tools">
      ${atStop ? `<button type="button" class="link-btn" data-back>${icon("arrowLeftRight")} Back to ${esc(atStop.name || "the stop")}</button>` : ""}
      ${ids.length > 1 ? `<button type="button" class="link-btn" data-dir title="Show the stops the other way round">Other direction</button>` : ""}
    </div>
    ${first && last ? `<p class="hint">${esc(first)} → ${esc(last)} · ${route.stops.length} stops</p>` : ""}
    <ol class="lc-stops" style="--c:${colour}">${route.stops.map((s, i) => `<li class="${s.name && s.name === here ? "here" : ""}"><button type="button" data-stop="${i}">${esc(s.name || "Stop")}</button></li>`).join("")}</ol>`);
  box.querySelector<HTMLButtonElement>("[data-back]")?.addEventListener("click", () => atStop && openStop(atStop.name, atStop.at, atStop.lines));
  box.querySelector<HTMLButtonElement>("[data-dir]")?.addEventListener("click", () => openLine(x, (dir + 1) % ids.length));
  box.querySelectorAll<HTMLButtonElement>("[data-stop]").forEach((b) => {
    b.onclick = () => {
      const s = route.stops[+b.dataset.stop!];
      box.querySelectorAll(".lc-stops li.on").forEach((li) => li.classList.remove("on"));
      b.parentElement!.classList.add("on");
      m?.flyTo([s.lat, s.lng], Math.max(m.getZoom(), 16), { duration: .6 });
    };
  });
  // The line's stops on the map, in its colour, so its whole way can be seen.
  marks.clearLayers();
  for (const s of route.stops) {
    L.circleMarker([s.lat, s.lng], { pane: "lineStops", radius: 4.5, color: colour, weight: 2.5, fillColor: "#fff", fillOpacity: 1, bubblingMouseEvents: false })
      .bindTooltip(esc(s.name || "Stop"), { direction: "top", offset: [0, -6], className: "leg-tip" }).addTo(marks);
  }
  // The stop it was opened from scrolled into view in the list.
  box.querySelector(".lc-stops li.here")?.scrollIntoView({ block: "center" });
}

/** Sets up the card (called once the map exists). */
export function initLineCard(map: L.Map) {
  m = map;
  marks = L.layerGroup().addTo(map);
  const Ctl = L.Control.extend({
    onAdd() {
      const el = L.DomUtil.create("div", "line-card");
      el.hidden = true;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      // Clicks stop here (the card redraws on a click, so the map couldn't tell where the click came from).
      for (const ev of ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "contextmenu"]) el.addEventListener(ev, (e) => e.stopPropagation());
      return el;
    },
  });
  box = new Ctl({ position: "topright" }).addTo(map).getContainer()!;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !box.hidden) close(); });
}
