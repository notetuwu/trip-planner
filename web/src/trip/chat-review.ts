// Before and after, side by side, for a change from the trip chat (like a git diff): what the plan, the costs, the map
// and the setup look like now and with the change. Opened from the change card; Apply / Discard happen in here.
import * as L from "leaflet";
import type { Day, ItineraryItem } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { money } from "../core/format";
import { icon } from "../core/icons";
import { type AppState, state } from "../core/state";
import { sameName, stayLoc } from "../geo/locate";

export type Snapshot = Pick<AppState, "itinerary" | "stays" | "marks" | "how" | "kept" | "customPlaces" | "travelers" | "dailyBudget" | "currency" | "pace" | "fitness" | "dayStart" | "breakfast" | "interests" | "wishes" | "notes" | "ideas" | "bookings" | "booked" | "car" | "meta">;
export const SNAP_KEYS: (keyof Snapshot)[] = ["itinerary", "stays", "marks", "how", "kept", "customPlaces", "travelers", "dailyBudget", "currency", "pace", "fitness", "dayStart", "breakfast", "interests", "wishes", "notes", "ideas", "bookings", "booked", "car", "meta"];
export const snapshot = (): Snapshot => structuredClone(Object.fromEntries(SNAP_KEYS.map((k) => [k, state[k]]))) as Snapshot;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const total = (s: Snapshot) => s.itinerary?.totalEstimatedCost ?? s.itinerary?.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0) ?? 0;
const budgetPerDay = (s: Snapshot) => (Number(s.dailyBudget) || 0) * Math.max(1, Number(s.travelers) || 1);

/** One line on what a change does to the money: the plan's total, and how many days go over the budget. */
export function impactLine(before: Snapshot, after: Snapshot) {
  const parts: string[] = [], cur = after.currency || "EUR";
  const a = total(before), b = total(after);
  if (Math.round(a) !== Math.round(b)) parts.push(`Plan ${money(a, cur)} → ${money(b, cur)} (${b > a ? "+" : "−"}${money(Math.abs(b - a), cur)})`);
  const over = (s: Snapshot) => (s.itinerary?.days || []).filter((d) => budgetPerDay(s) && (Number(d.estimatedCost) || 0) > budgetPerDay(s)).length;
  if (over(before) !== over(after)) parts.push(`days over budget ${over(before)} → ${over(after)}`);
  const n = (s: Snapshot) => s.stays.filter((x) => x.city).reduce((k, x) => k + (Number(x.nights) || 0), 0);
  if (n(before) !== n(after)) parts.push(`nights ${n(before)} → ${n(after)}`);
  return parts.join(" · ");
}

/** The days a change touches (by index). */
const changedDays = (a: Snapshot, b: Snapshot) => {
  const n = Math.max(a.itinerary?.days.length || 0, b.itinerary?.days.length || 0);
  return Array.from({ length: n }, (_, i) => i).filter((i) => !same(a.itinerary?.days[i], b.itinerary?.days[i]));
};

const itemKey = (x: ItineraryItem) => sameName(x.place);
function dayColumn(d: Day | undefined, other: Day | undefined, side: "before" | "after", cur: string) {
  if (!d) return `<div class="rv-col"><p class="hint">No day</p></div>`;
  const others = new Map((other?.items || []).map((x) => [itemKey(x), x]));
  const rows = d.items.map((x) => {
    const o = others.get(itemKey(x));
    const cls = !o ? (side === "before" ? "rm" : "add") : o.time !== x.time || Number(o.cost) !== Number(x.cost) ? "mod" : "";
    return `<li class="${cls}"><span class="rv-time">${esc(x.time || "")}</span><span class="rv-place">${esc(x.place)}</span><span class="rv-cost">${x.cost ? money(Number(x.cost), cur) : ""}</span></li>`;
  }).join("");
  return `<div class="rv-col"><div class="rv-col-head">${esc(d.date)} · ${esc(d.city)}</div><ol class="rv-items">${rows}</ol><div class="rv-col-foot">${money(Number(d.estimatedCost) || 0, cur)}</div></div>`;
}

function planTab(a: Snapshot, b: Snapshot) {
  const cur = b.currency || "EUR";
  return changedDays(a, b).map((i) => `<h4 class="rv-day">Day ${i + 1}</h4><div class="rv-pair">${dayColumn(a.itinerary?.days[i], b.itinerary?.days[i], "before", cur)}${dayColumn(b.itinerary?.days[i], a.itinerary?.days[i], "after", cur)}</div>`).join("");
}

function costsTab(a: Snapshot, b: Snapshot) {
  const cur = b.currency || "EUR", n = Math.max(a.itinerary?.days.length || 0, b.itinerary?.days.length || 0);
  const cell = (s: Snapshot, i: number) => Number(s.itinerary?.days[i]?.estimatedCost) || 0;
  const rows = Array.from({ length: n }, (_, i) => {
    const x = cell(a, i), y = cell(b, i), d = b.itinerary?.days[i] || a.itinerary?.days[i];
    return `<tr class="${x !== y ? "mod" : ""}"><td>Day ${i + 1} <span class="muted">${esc(d?.city || "")}</span></td><td class="num">${money(x, cur)}</td><td class="num">${money(y, cur)}</td><td class="num">${x !== y ? `${y > x ? "+" : "−"}${money(Math.abs(y - x), cur)}` : ""}</td></tr>`;
  }).join("");
  const bud = (s: Snapshot) => budgetPerDay(s) * (s.itinerary?.days.length || 0);
  return `<table class="rv-table"><thead><tr><th></th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${money(total(a), cur)}</td><td class="num">${money(total(b), cur)}</td><td class="num">${total(a) !== total(b) ? `${total(b) > total(a) ? "+" : "−"}${money(Math.abs(total(b) - total(a)), cur)}` : ""}</td></tr>
    <tr><td>Budget</td><td class="num">${money(bud(a), cur)}</td><td class="num">${money(bud(b), cur)}</td><td></td></tr></tfoot></table>`;
}

const FIELDS: [keyof Snapshot, string][] = [["travelers", "Travelers"], ["dailyBudget", "Budget per person a day"], ["currency", "Currency"], ["pace", "Pace"], ["fitness", "Fitness"], ["dayStart", "Days start"], ["breakfast", "Breakfast"], ["interests", "Interests"], ["wishes", "What they want to see"], ["notes", "Notes for the plan"], ["ideas", "Ideas & notes"]];
function setupTab(a: Snapshot, b: Snapshot) {
  const rows: string[] = [];
  const row = (label: string, x: string, y: string) => rows.push(`<tr><td>${esc(label)}</td><td class="rv-old">${esc(x || "—")}</td><td class="rv-new">${esc(y || "—")}</td></tr>`);
  for (const [k, label] of FIELDS) if (!same(a[k], b[k])) row(label, String(a[k] ?? ""), String(b[k] ?? ""));
  const stay = (s: Snapshot) => s.stays.filter((x) => x.city).map((x) => `${x.city} · ${x.nights} night${x.nights === 1 ? "" : "s"}${x.travel ? ` · by ${x.travel}` : ""}${x.hotel ? ` · ${x.hotel}` : ""}${x.dayTrips?.length ? ` · day trips: ${x.dayTrips.map((d) => d.place).join(", ")}` : ""}`).join("\n");
  if (stay(a) !== stay(b)) row("Stays", stay(a), stay(b));
  const marks = (s: Snapshot, m: string) => Object.entries(s.marks || {}).filter(([, v]) => v === m).map(([k]) => k).sort().join(", ");
  for (const [m, label] of [["must", "Must-sees"], ["skip", "Skipped"]] as const) if (marks(a, m) !== marks(b, m)) row(label, marks(a, m), marks(b, m));
  const bk = (s: Snapshot) => (s.bookings || []).map((x) => `${x.name} ${x.date}${x.from ? ` ${x.from}` : ""}`).join("\n");
  if (bk(a) !== bk(b)) row("Bookings", bk(a), bk(b));
  if (!same(a.car, b.car)) row("Car", a.car ? `${a.car.fuel} ${a.car.per100 || ""}` : "", b.car ? `${b.car.fuel} ${b.car.per100 || ""}` : "");
  if (!same(a.booked, b.booked)) row("Ticked off to book", Object.keys(a.booked || {}).filter((k) => a.booked![k]).length + "", Object.keys(b.booked || {}).filter((k) => b.booked![k]).length + "");
  return rows.length ? `<table class="rv-table rv-setup"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "";
}

/** Where a snapshot's stays and changed days' stops are, for the maps. */
function points(s: Snapshot, days: number[]) {
  const stays = s.stays.filter((x) => x.city).map((x) => stayLoc(x)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => [l.lat, l.lng] as L.LatLngTuple);
  const stops = days.flatMap((i) => (s.itinerary?.days[i]?.items || []).filter((x) => typeof x.lat === "number" && typeof x.lng === "number").map((x) => ({ at: [x.lat!, x.lng!] as L.LatLngTuple, name: x.place, key: itemKey(x) })));
  return { stays, stops };
}

let maps: L.Map[] = [];
function drawMaps(a: Snapshot, b: Snapshot) {
  for (const m of maps) m.remove();
  maps = [];
  const days = changedDays(a, b);
  const pa = points(a, days), pb = points(b, days);
  const keysA = new Set(pa.stops.map((p) => p.key)), keysB = new Set(pb.stops.map((p) => p.key));
  const all = [...pa.stays, ...pb.stays, ...pa.stops.map((p) => p.at), ...pb.stops.map((p) => p.at)];
  if (!all.length) return false;
  const make = (id: string, p: ReturnType<typeof points>, other: Set<string>, side: "before" | "after") => {
    const m = L.map(id, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    if (p.stays.length > 1) L.polyline(p.stays, { color: side === "before" ? "#8a8a8a" : "#2f6fed", weight: 4, opacity: .85 }).addTo(m);
    p.stays.forEach((at, i) => L.circleMarker(at, { radius: 7, color: "#fff", weight: 2, fillColor: side === "before" ? "#8a8a8a" : "#2f6fed", fillOpacity: 1 }).bindTooltip(`${i + 1}`).addTo(m));
    for (const s of p.stops) {
      const changed = !other.has(s.key);
      const color = changed ? (side === "before" ? "#d64545" : "#2e9d5b") : "#999";
      L.circleMarker(s.at, { radius: changed ? 6 : 4, color, fillColor: color, fillOpacity: .9, weight: 1 }).bindTooltip(esc(s.name)).addTo(m);
    }
    m.fitBounds(L.latLngBounds(all), { padding: [20, 20], maxZoom: 13 });
    return m;
  };
  const ma = make("rvMapA", pa, keysB, "before"), mb = make("rvMapB", pb, keysA, "after");
  // Pan and zoom together.
  let syncing = false;
  const link = (from: L.Map, to: L.Map) => from.on("move", () => { if (syncing) return; syncing = true; to.setView(from.getCenter(), from.getZoom(), { animate: false }); syncing = false; });
  link(ma, mb); link(mb, ma);
  maps = [ma, mb];
  return true;
}

export interface ReviewAction { label: string; primary?: boolean; run: () => void }

/** Opens the compare window: tabs for what changed (plan, costs, map, setup), before on the left, after on the right. */
export function openReview(title: string, a: Snapshot, b: Snapshot, actions: ReviewAction[]) {
  closeReview();
  const plan = planTab(a, b), costs = total(a) !== total(b) ? costsTab(a, b) : "", setup = setupTab(a, b);
  const mapWorth = changedDays(a, b).length > 0 || !same(a.stays, b.stays);
  const tabs = [["plan", "Plan", plan], ["costs", "Costs", costs], ["map", "Map", mapWorth ? "map" : ""], ["setup", "Setup", setup]].filter(([, , html]) => html);
  const el = document.createElement("div");
  el.id = "rvModal";
  el.className = "rv-backdrop";
  el.innerHTML = `<div class="rv-modal" role="dialog" aria-label="Before and after">
    <div class="rv-head"><b>${esc(title)}</b><button type="button" class="icon-btn" data-rv-close title="Close">${icon("x")}</button></div>
    <div class="rv-impact">${esc(impactLine(a, b) || "")}</div>
    ${tabs.length ? `<div class="rv-tabs">${tabs.map(([k, label], i) => `<button type="button" class="seg${i ? "" : " on"}" data-rv-tab="${k}">${label}</button>`).join("")}</div>
    <div class="rv-legend"><span><i class="rv-sw before"></i> Before</span><span><i class="rv-sw after"></i> After</span><span class="add">added</span><span class="rm">removed</span><span class="mod">changed</span></div>
    ${tabs.map(([k, , html], i) => `<div class="rv-pane" data-rv-pane="${k}"${i ? " hidden" : ""}>${k === "map" ? `<div class="rv-pair"><div class="rv-col"><div class="rv-col-head">Before</div><div id="rvMapA" class="rv-map"></div></div><div class="rv-col"><div class="rv-col-head">After</div><div id="rvMapB" class="rv-map"></div></div></div>` : html}</div>`).join("")}`
      : `<p class="hint">Nothing in the trip changes.</p>`}
    <div class="rv-actions">${actions.map((x, i) => `<button type="button" class="btn${x.primary ? " solid" : ""}" data-rv-act="${i}">${esc(x.label)}</button>`).join("")}</div></div>`;
  document.body.appendChild(el);
  let mapsDrawn = false;
  const show = (k: string) => {
    el.querySelectorAll<HTMLElement>("[data-rv-tab]").forEach((t) => t.classList.toggle("on", t.dataset.rvTab === k));
    el.querySelectorAll<HTMLElement>("[data-rv-pane]").forEach((p) => { p.hidden = p.dataset.rvPane !== k; });
    if (k === "map" && !mapsDrawn) { mapsDrawn = true; if (!drawMaps(a, b)) $("[data-rv-pane=map]").innerHTML = `<p class="hint">Nothing to show on the map yet (the places are still being located).</p>`; }
  };
  el.querySelectorAll<HTMLButtonElement>("[data-rv-tab]").forEach((t) => { t.onclick = () => show(t.dataset.rvTab!); });
  if (tabs[0]?.[0] === "map") show("map");
  el.querySelectorAll<HTMLButtonElement>("[data-rv-act]").forEach((btn) => { btn.onclick = () => { closeReview(); actions[+btn.dataset.rvAct!].run(); }; });
  el.querySelector<HTMLButtonElement>("[data-rv-close]")!.onclick = () => closeReview();
  el.addEventListener("click", (e) => { if (e.target === el) closeReview(); });
}

export function closeReview() {
  for (const m of maps) m.remove();
  maps = [];
  document.querySelector("#rvModal")?.remove();
}
