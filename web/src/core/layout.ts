// What the page shows. On a computer: any of the three columns (the trip's settings, the plan, the map) can be hidden
// from the header, and the map can take the whole window (the button on the map, or Escape to come back). On a phone:
// one of them or the chat at a time, picked in a bar along the bottom, and while going through the plan a bar of its
// days along the top, to jump to any of them.
import { $, $$ } from "./dom";
import { icon } from "./icons";
import { session, state } from "./state";
import { mapShown } from "../map/draw";

export type Pane = "settings" | "output" | "map";
const PANES: Pane[] = ["settings", "output", "map"];
const HIDDEN = "trip-planner-hidden-panes", PHONE_TAB = "trip-planner-phone-tab";
const NAMES: Record<Pane, string> = { settings: "Trip", output: "Plan", map: "Map" };
const ICONS = { settings: "sliders", output: "list", map: "map" } as const;

const read = (): Set<Pane> => { try { return new Set((JSON.parse(localStorage.getItem(HIDDEN) || "[]") as Pane[]).filter((p) => PANES.includes(p))); } catch { return new Set(); } };
let hidden = read();
/** What was hidden before the map took the whole window (to go back to). */
let beforeFull: Set<Pane> | null = null;
/** The phone tab picked; until one is, the plan when there is one, else the trip. */
let chosen = (sessionStorage.getItem(PHONE_TAB) as Pane) || "";
const tabNow = (): Pane => chosen || (state.itinerary ? "output" : "settings");

export const isPhone = () => window.innerWidth <= 900;
const mapFull = () => hidden.has("settings") && hidden.has("output");
/** Side by side from this width (narrower: the map over the plan). */
const ROW = 1200;
const chatOpen = () => document.body.classList.contains("chat-open");
const chatColumn = () => chatOpen() && window.innerWidth >= 1180;
/** The map over the plan (rather than beside it): a narrow window, or the chat taking a column under 1500px. */
const stackedNow = () => !isPhone() && !hidden.has("output") && !hidden.has("map") && (window.innerWidth < ROW || (chatColumn() && window.innerWidth < 1500));
const MAP_H = "trip-planner-map-height";

/** The columns side by side, or the map over the plan (as the page lays them out without any hidden). */
function desktopGrid() {
  const main = $("main"), body = document.body;
  // (Each class changed once, if at all: a change sets off the watcher of the chat opening below.)
  // (Only changed when it changes: a class change sets off the watcher of the chat opening below.)
  if (body.classList.contains("map-stacked") !== stackedNow()) body.classList.toggle("map-stacked", stackedNow());
  if (isPhone() || !hidden.size) { body.classList.toggle("layout-row", false); main.style.removeProperty("grid-template-columns"); main.style.removeProperty("grid-template-areas"); main.style.removeProperty("grid-template-rows"); return; }
  const shown = (p: Pane) => !hidden.has(p);
  const chat = chatColumn();
  const stack = stackedNow();
  const cols: [string, string][] = [];
  if (shown("settings")) cols.push(["settings", chat || window.innerWidth < 1500 ? "minmax(300px, 350px)" : "minmax(340px, 400px)"]);
  if (stack) cols.push(["stack", "minmax(0, 1fr)"]);
  else { if (shown("output")) cols.push(["output", "minmax(0, 1fr)"]); if (shown("map")) cols.push(["map", "minmax(0, 1fr)"]); }
  if (chat) cols.push(["chat", "minmax(300px, 380px)"]);
  const row = (which: string) => `"${cols.map(([a]) => (a === "stack" ? which : a)).join(" ")}"`;
  main.style.gridTemplateColumns = cols.map(([, w]) => w).join(" ");
  main.style.gridTemplateAreas = stack ? `${row("map")} ${row("output")}` : row("");
  main.style.gridTemplateRows = stack ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)";
  // Beside the others, the map fills its column from top to bottom.
  body.classList.toggle("layout-row", !stack && shown("map"));
}

function apply() {
  const body = document.body, phone = isPhone();
  // On a phone the open chat is a tab of its own, in place of the others.
  const tab = chatOpen() && phone ? "chat" : tabNow();
  for (const p of PANES) {
    body.classList.toggle(`hide-${p}`, !phone && hidden.has(p));
    body.classList.toggle(`m-${p}`, phone && tab === p);
  }
  body.classList.toggle("map-full", !phone && mapFull());
  desktopGrid();
  for (const b of $$<HTMLButtonElement>("[data-pane]")) {
    const p = b.dataset.pane as Pane, on = !hidden.has(p);
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    b.title = `${on ? "Hide" : "Show"} ${p === "settings" ? "the trip's settings" : p === "output" ? "the plan" : "the map"}`;
  }
  for (const b of $$<HTMLButtonElement>("[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
  $("[data-tab-chat]").classList.toggle("on", tab === "chat");
  const full = document.querySelector<HTMLButtonElement>("#mapFullBtn");
  if (full) { full.innerHTML = icon(mapFull() ? "minimize" : "maximize"); full.title = mapFull() ? "Back to the columns (Esc)" : "The map over the whole window"; }
  // Where the header ends (the map on a phone fills what's below it).
  document.documentElement.style.setProperty("--mhead", `${Math.round(document.querySelector("header")!.getBoundingClientRect().bottom + window.scrollY)}px`);
  dayBar();
  requestAnimationFrame(mapShown);
}

/** Shows or hides a column (one of them always stays). */
export function togglePane(p: Pane) {
  if (hidden.has(p)) hidden.delete(p);
  else if (PANES.filter((x) => !hidden.has(x)).length > 1) hidden.add(p);
  beforeFull = null;
  localStorage.setItem(HIDDEN, JSON.stringify([...hidden]));
  apply();
}

/** The map over the whole window, or back to how it was. */
export function toggleMapFull() {
  if (mapFull()) hidden = beforeFull && !(beforeFull.has("settings") && beforeFull.has("output")) ? beforeFull : new Set();
  else { beforeFull = new Set(hidden); hidden = new Set(["settings", "output"]); }
  localStorage.setItem(HIDDEN, JSON.stringify([...hidden]));
  apply();
}

/** Brings a pane into view: on a phone its tab, on a computer the column if it was hidden. */
export function showPane(p: Pane) {
  if (isPhone()) {
    const fromChat = chatOpen();
    if (fromChat) $("#cpClose").click();
    if (tabNow() === p && !fromChat) return;
    chosen = p; sessionStorage.setItem(PHONE_TAB, p);
    window.scrollTo({ top: 0 });
    apply();
  } else if (hidden.has(p)) togglePane(p);
}

/** The bar of days along the top on a phone, once the plan is scrolled to its days. */
function dayBar() {
  const bar = document.querySelector<HTMLElement>("#mDayBar")!, days = $$<HTMLElement>("#output .day");
  const want = isPhone() && !chatOpen() && tabNow() === "output" && days.length > 0;
  if (!want) { bar.hidden = true; return; }
  const it = state.itinerary;
  const key = days.map((d) => d.dataset.date).join(",");
  if (bar.dataset.key !== key) {
    bar.dataset.key = key;
    let town = "";
    bar.innerHTML = days.map((d) => {
      const i = +d.dataset.i!, day = it?.days[i], date = day ? new Date(`${day.date}T12:00:00`) : null;
      const city = String(day?.city || "").split(/\/|â†’|->|,/)[0].trim(), first = city && city !== town;
      if (city) town = city;
      return `${first ? `<span class="m-town">${city}</span>` : ""}<button type="button" data-day="${i}"><b>${i + 1}</b>${date && !isNaN(+date) ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : ""}</button>`;
    }).join("");
  }
  // Seen once the first day has come up under the top of the screen.
  const first = days[0].getBoundingClientRect().top;
  bar.hidden = first > 80;
  let cur = days[0];
  for (const d of days) if (d.getBoundingClientRect().top < 120) cur = d;
  const on = bar.querySelector<HTMLElement>(`button[data-day="${cur.dataset.i}"]`);
  if (on && !on.classList.contains("on")) {
    bar.querySelector(".on")?.classList.remove("on");
    on.classList.add("on");
    bar.scrollTo({ left: on.offsetLeft - bar.clientWidth / 2 + on.offsetWidth / 2, behavior: "smooth" });
  }
}

function jumpToDay(i: number) {
  const el = document.querySelector<HTMLElement>(`#output .day[data-i="${i}"]`);
  if (!el) return;
  // A folded stay opens to show the day.
  const group = el.closest<HTMLElement>(".stay-group");
  if (group?.classList.contains("folded")) { session.foldedStays.delete(+group.dataset.stayGroup!); group.classList.remove("folded"); }
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 56, behavior: "smooth" });
}

/** The handle under the map where it's over the plan: dragged, the map gets taller or shorter (kept for next time). */
function mapResizer() {
  const saved = Number(localStorage.getItem(MAP_H));
  if (saved >= 160) document.documentElement.style.setProperty("--map-h", `${saved}px`);
  const handle = document.createElement("div");
  handle.className = "map-resize"; handle.title = "Drag to make the map taller or shorter (double-click: back to the usual size)";
  handle.innerHTML = icon("grip");
  $(".map-panel").append(handle);
  const map = () => document.querySelector<HTMLElement>("#map")!;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY, startH = map().getBoundingClientRect().height;
    handle.classList.add("drag"); document.body.classList.add("resizing-map");
    let frame = 0, h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(160, Math.min(window.innerHeight * 0.75, startH + ev.clientY - startY)));
      document.documentElement.style.setProperty("--map-h", `${h}px`);
      // The map redraws for its new size (Leaflet follows the window's resize).
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up);
      handle.classList.remove("drag"); document.body.classList.remove("resizing-map");
      localStorage.setItem(MAP_H, String(h));
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty("--map-h"); localStorage.removeItem(MAP_H);
    window.dispatchEvent(new Event("resize"));
  });
}

export function initLayout() {
  // The column switches in the header (a computer), the tabs along the bottom and the day bar (a phone).
  $("#headerTools").insertAdjacentHTML("afterbegin", `<div class="pane-btns" role="group" aria-label="Columns">${PANES.map((p) =>
    `<button type="button" data-pane="${p}">${icon(ICONS[p])}<span>${NAMES[p]}</span></button>`).join("")}</div>`);
  document.body.insertAdjacentHTML("beforeend", `<nav class="m-tabs" aria-label="Sections">${PANES.map((p) =>
    `<button type="button" data-tab="${p}">${icon(ICONS[p])}<span>${NAMES[p]}</span></button>`).join("")}<button type="button" data-tab-chat>${icon("chat")}<span>Chat</span></button></nav>
    <nav class="m-daybar" id="mDayBar" hidden aria-label="Days"></nav>`);
  $(".map-toggles").insertAdjacentHTML("beforeend", `<button type="button" class="map-pill map-full-btn" id="mapFullBtn"></button>`);
  for (const b of $$<HTMLButtonElement>("[data-pane]")) b.onclick = () => togglePane(b.dataset.pane as Pane);
  for (const b of $$<HTMLButtonElement>("[data-tab]")) b.onclick = () => showPane(b.dataset.tab as Pane);
  $("[data-tab-chat]").onclick = () => { if (!chatOpen()) $("#chatBtn").click(); };
  $("#mapFullBtn").onclick = toggleMapFull;
  $("#mDayBar").onclick = (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]"); if (b) jumpToDay(+b.dataset.day!); };
  // On a phone, making a plan shows it.
  $("#generate").addEventListener("click", () => showPane("output"));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !mapFull() || isPhone() || document.querySelector("dialog[open], .lightbox")) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select, .chat-panel")) return;
    toggleMapFull();
  });
  let frame = 0;
  addEventListener("scroll", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(dayBar); }, { passive: true });
  let wasPhone = isPhone();
  addEventListener("resize", () => { if (isPhone() !== wasPhone) { wasPhone = isPhone(); apply(); } else { desktopGrid(); dayBar(); } });
  // The chat opening or closing changes the columns (on a phone, the tab); a new plan, the day bar.
  let chatWas = chatOpen();
  new MutationObserver(() => {
    const chat = chatOpen(), turned = chat !== chatWas;
    chatWas = chat;
    if (isPhone() && turned) { window.scrollTo({ top: 0 }); apply(); }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => { if (!isPhone()) { const was = document.body.classList.contains("map-stacked"); desktopGrid(); if (hidden.size || was !== document.body.classList.contains("map-stacked")) requestAnimationFrame(mapShown); } }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  mapResizer();
  new MutationObserver(() => { if (!chosen && isPhone()) apply(); else dayBar(); }).observe($("#output"), { childList: true });
  apply();
}
