// Before and after, side by side, for a change from the trip chat (like a git diff): what the plan, the costs, the map
// and the setup look like now and with the change. Opened from the change card; Apply / Discard happen in here.
import * as L from "leaflet";
import type { Day, ItineraryItem } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { money } from "../core/format";
import { icon } from "../core/icons";
import { type AppState, state } from "../core/state";
import { sameName, stayLoc } from "../geo/locate";
import { byTitleMap } from "../geo/item-loc";
import { type Leg, dayLegs, legRoute, requestRoutes } from "../map/routes";
import type { LatLng } from "../../../shared/types";

export type Snapshot = Pick<AppState, "itinerary" | "stays" | "marks" | "how" | "kept" | "customPlaces" | "travelers" | "dailyBudget" | "currency" | "pace" | "fitness" | "getAround" | "placeMix" | "dayStart" | "breakfast" | "interests" | "wishes" | "notes" | "ideas" | "bookings" | "booked" | "packed" | "packingExtra" | "car" | "meta">;
export const SNAP_KEYS: (keyof Snapshot)[] = ["itinerary", "stays", "marks", "how", "kept", "customPlaces", "travelers", "dailyBudget", "currency", "pace", "fitness", "getAround", "placeMix", "dayStart", "breakfast", "interests", "wishes", "notes", "ideas", "bookings", "booked", "packed", "packingExtra", "car", "meta"];
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

const FIELDS: [keyof Snapshot, string][] = [["travelers", "Travelers"], ["dailyBudget", "Budget per person a day"], ["currency", "Currency"], ["pace", "Pace"], ["fitness", "Fitness"], ["getAround", "Getting around"], ["placeMix", "Places"], ["dayStart", "Days start"], ["breakfast", "Breakfast"], ["interests", "Interests"], ["wishes", "What they want to see"], ["notes", "Notes for the plan"], ["ideas", "Ideas & notes"]];
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
  const ticked = (m?: Record<string, boolean>) => Object.keys(m || {}).filter((k) => m![k]).map((k) => k.split("|").pop()).sort().join("\n");
  if (!same(a.booked, b.booked)) row("Ticked off in Book ahead", ticked(a.booked), ticked(b.booked));
  if (!same(a.packed, b.packed)) row("Packed", ticked(a.packed), ticked(b.packed));
  if (!same(a.packingExtra, b.packingExtra)) row("Your own packing items", (a.packingExtra || []).join("\n"), (b.packingExtra || []).join("\n"));
  return rows.length ? `<table class="rv-table rv-setup"><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "";
}

/** A snapshot's lines for the map: the drives between stays and the changed days' legs, along the real roads and paths
 *  where the routing service has them (the same routes as the main map), with the driving on those days added up. */
function mapLines(s: Snapshot, days: number[]) {
  const byTitle = byTitleMap(), segs: { pts: LatLng[]; routed: boolean; stay: boolean }[] = [], want: Pick<Leg, "mode" | "from" | "to">[] = [];
  let km = 0, mins = 0;
  const st = s.stays.filter((x) => x.city);
  for (let i = 1; i < st.length; i++) {
    const a = stayLoc(st[i - 1]), b = stayLoc(st[i]);
    if (!a || !b) continue;
    const leg = { mode: "car" as const, from: [a.lat, a.lng] as LatLng, to: [b.lat, b.lng] as LatLng };
    const r = st[i].travel === "car" ? legRoute(leg) : null;
    if (st[i].travel === "car" && !r) want.push(leg);
    segs.push({ pts: r ? r.c : [leg.from, leg.to], routed: !!r, stay: true });
  }
  for (const i of days) {
    const d = s.itinerary?.days[i];
    if (!d) continue;
    for (const l of dayLegs(d, byTitle)) {
      const r = legRoute(l);
      if (!r && l.mode !== "straight") want.push(l);
      if (r && l.mode === "car") { km += r.d / 1000; mins += r.t / 60; }
      segs.push({ pts: r ? r.c : [l.from, l.to], routed: !!r, stay: false });
    }
  }
  const stops = days.flatMap((i) => (s.itinerary?.days[i]?.items || []).filter((x) => typeof x.lat === "number" && typeof x.lng === "number").map((x) => ({ at: [x.lat!, x.lng!] as LatLng, name: x.place, key: itemKey(x) })));
  return { segs, want, km, mins, stops, stays: st.map((x) => stayLoc(x)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => [l.lat, l.lng] as LatLng) };
}

const drive = (km: number, mins: number) => (km ? `${Math.round(km).toLocaleString()} km, ${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min driving on the changed days` : "");

let maps: L.Map[] = [], retry = 0;
function drawMaps(a: Snapshot, b: Snapshot, tries = 0): boolean {
  for (const m of maps) m.remove();
  maps = [];
  clearTimeout(retry);
  const days = changedDays(a, b);
  const pa = mapLines(a, days), pb = mapLines(b, days);
  const keysA = new Set(pa.stops.map((p) => p.key)), keysB = new Set(pb.stops.map((p) => p.key));
  const all = [...pa.stays, ...pb.stays, ...pa.stops.map((p) => p.at), ...pb.stops.map((p) => p.at)];
  if (!all.length) return false;
  const make = (id: string, p: ReturnType<typeof mapLines>, other: Set<string>, side: "before" | "after") => {
    const m = L.map(id, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    const color = side === "before" ? "#8a8a8a" : "#2f6fed";
    for (const g of p.segs) L.polyline(g.pts as L.LatLngTuple[], { color, weight: g.stay ? 4 : 3, opacity: g.stay ? .55 : .9, ...(g.routed ? {} : { dashArray: "6 6" }) }).addTo(m);
    p.stays.forEach((at, i) => L.circleMarker(at as L.LatLngTuple, { radius: 7, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 }).bindTooltip(`Stay ${i + 1}`).addTo(m));
    for (const s of p.stops) {
      const changed = !other.has(s.key), c = changed ? (side === "before" ? "#d64545" : "#2e9d5b") : color;
      L.circleMarker(s.at as L.LatLngTuple, { radius: changed ? 7 : 4, color: "#fff", weight: 1.5, fillColor: c, fillOpacity: 1 }).bindTooltip(esc(s.name)).addTo(m);
    }
    m.fitBounds(L.latLngBounds(all as L.LatLngTuple[]), { padding: [20, 20], maxZoom: 13 });
    return m;
  };
  const ma = make("rvMapA", pa, keysB, "before"), mb = make("rvMapB", pb, keysA, "after");
  const head = (id: string, label: string, p: ReturnType<typeof mapLines>) => { const el = document.getElementById(id); if (el) el.innerHTML = `${label}<span class="rv-drive">${esc(drive(p.km, p.mins))}</span>`; };
  head("rvHeadA", "Before", pa); head("rvHeadB", "After", pb);
  // Pan and zoom together.
  let syncing = false;
  const link = (from: L.Map, to: L.Map) => from.on("move", () => { if (syncing) return; syncing = true; to.setView(from.getCenter(), from.getZoom(), { animate: false }); syncing = false; });
  link(ma, mb); link(mb, ma);
  maps = [ma, mb];
  // Routes not known yet (a new stop): asked for, and the maps drawn again when they're in.
  const want = [...pa.want, ...pb.want];
  if (want.length && tries < 12) {
    requestRoutes(want);
    retry = window.setTimeout(() => { if (document.getElementById("rvMapA")) { const v = ma.getCenter(), z = ma.getZoom(); drawMaps(a, b, tries + 1); maps[0]?.setView(v, z, { animate: false }); } }, 1500);
  }
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
    ${tabs.length ? `<div class="rv-tabs">${tabs.map(([k, label], i) => `<button type="button" class="rv-tab${i ? "" : " on"}" data-rv-tab="${k}">${label}</button>`).join("")}</div>
    <div class="rv-legend"><span><i class="rv-sw before"></i> Before</span><span><i class="rv-sw after"></i> After</span><span class="add">added</span><span class="rm">removed</span><span class="mod">changed</span></div>
    ${tabs.map(([k, , html], i) => `<div class="rv-pane" data-rv-pane="${k}"${i ? " hidden" : ""}>${k === "map" ? `<div class="rv-pair"><div class="rv-col"><div class="rv-col-head" id="rvHeadA">Before</div><div id="rvMapA" class="rv-map"></div></div><div class="rv-col"><div class="rv-col-head" id="rvHeadB">After</div><div id="rvMapB" class="rv-map"></div></div></div>` : html}</div>`).join("")}`
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
  clearTimeout(retry);
  for (const m of maps) m.remove();
  maps = [];
  document.querySelector("#rvModal")?.remove();
}
