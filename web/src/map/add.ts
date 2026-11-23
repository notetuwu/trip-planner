// The "add this spot" popup: opened by clicking the map, a search result, or a saved place's "Add to a day".
import * as L from "leaflet";
import type { ReverseHit } from "../../../shared/types";
import { $$, api, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { session, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc } from "../geo/locate";
import { addCustomPlace, addStop } from "./edit";
import { map } from "./map";
import { icon } from "../core/icons";

/** Puts text on the clipboard; also over plain http on the home network, where the clipboard API isn't offered. */
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not a secure page: the old way */ }
  const t = document.createElement("textarea");
  t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
  document.body.append(t); t.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { t.remove(); }
}

export const toMin = (t: string | undefined) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** The day whose stops (or stay city) are closest to a point. */
function nearestDay(pt: L.LatLng) {
  const byTitle = byTitleMap();
  let best = 0, bestD = Infinity;
  state.itinerary!.days.forEach((d, i) => {
    const stay = state.stays.find((s) => s.city === d.city);
    const locs = [...d.items.map((x) => itemLoc(x, d, byTitle)), stay && stayLoc(stay)];
    for (const l of locs) if (l) { const dist = distKm(pt, l); if (dist < bestD) { bestD = dist; best = i; } }
  });
  return best;
}

/** Right after the day's stop nearest to the new spot (before the stop after it); else an hour after the last stop. */
function defaultTime(di: number, pt?: L.LatLng) {
  const d = state.itinerary!.days[di], byTitle = byTitleMap();
  const timed = d.items.map((x) => ({ t: toMin(x.time), loc: itemLoc(x, d, byTitle) })).filter((s): s is { t: number; loc: typeof s.loc } => s.t != null);
  if (!timed.length) return "12:00";
  const located = pt ? timed.filter((s) => s.loc) : [];
  if (pt && located.length) {
    const near = located.reduce((a, b) => (distKm(pt, b.loc!) < distKm(pt, a.loc!) ? b : a));
    const next = Math.min(...timed.map((s) => s.t).filter((t) => t > near.t), Infinity);
    return fromMin(Math.min(near.t + 45, next === Infinity ? 23 * 60 : Math.round((near.t + next) / 2)));
  }
  return fromMin(Math.min(Math.max(...timed.map((s) => s.t)) + 60, 23 * 60));
}

interface Preset { name?: string; label?: string; fromList?: boolean }

/** Names the spot at the level you're looking at: zoomed out on a region you mean the town, not the shop under the cursor. */
function pickName(r: ReverseHit) {
  const z = map!.getZoom(), want = z >= 16 ? "place" : z >= 13 ? "area" : "town";
  const options = r.options || [];
  return options.find((o) => o.level === want) || (want === "area" && options.find((o) => o.level === "town")) || options[0];
}

export function openAddPopup(latlng: L.LatLng, preset: Preset = {}) {
  if (!map) return;
  const it = state.itinerary;
  const di = it ? session.selectedDay ?? nearestDay(latlng) : 0;
  // Top padding keeps the form clear of the search box.
  const popup = L.popup({ minWidth: 250, autoPanPaddingTopLeft: [10, 64] }).setLatLng(latlng).setContent(`
    <form class="add-form">
      <b>${it ? "Add to the itinerary" : "Add as a must-see place"}</b>
      <div class="pop-addr"><div class="pop-meta ${preset.name ? "" : "lookup"}" data-label>${preset.name ? esc(preset.label || "") : "Looking up this spot…"}</div>
        <button type="button" class="icon-btn pop-copy" data-copy title="Copy the address" aria-label="Copy the address">${icon("copy")}</button></div>
      <input name="placeName" required placeholder="Name" value="${esc(preset.name || "")}">
      <div class="name-options" data-options></div>
      ${it ? `<div class="add-row">
        <select name="day">${it.days.map((d, i) => `<option value="${i}" ${i === di ? "selected" : ""}>${esc(fmtDate(d.date) || `Day ${i + 1}`)} · ${esc(d.city)}</option>`).join("")}</select>
        <input name="time" type="time" value="${defaultTime(di, latlng)}">
      </div>` : ""}
      <input name="desc" placeholder="Note (optional)">
      <div class="pop-actions"><button type="submit" class="on">${it ? `${icon("plus")} Add` : `${icon("star")} Add must-see`}</button></div>
    </form>`).openOn(map);
  const el = popup.getElement()!, form = el.querySelector("form")!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as T;
  const nameInput = field("placeName"), daySelect = field<HTMLSelectElement>("day"), timeInput = field("time");
  if (it) daySelect.onchange = () => { timeInput.value = defaultTime(+daySelect.value, latlng); };
  let address = preset.label || "";
  if (!preset.name) {
    api<ReverseHit>(`/api/reverse?lat=${latlng.lat}&lng=${latlng.lng}`).then((r) => {
      el.querySelector("[data-label]")!.textContent = r.label || "";
      address = r.short || r.label || "";
      if (!nameInput.value) nameInput.value = pickName(r)?.name || r.name || "";
      if ((r.options || []).length > 1) {
        el.querySelector("[data-options]")!.innerHTML = r.options.map((o) =>
          `<button type="button" class="${o.name === nameInput.value ? "on" : ""}" data-name="${esc(o.name)}" title="${o.level}">${esc(o.name)}</button>`).join("");
      }
    }).catch(() => { el.querySelector("[data-label]")!.textContent = ""; });
  }
  el.querySelector<HTMLButtonElement>("[data-copy]")!.onclick = async (e) => {
    const b = e.currentTarget as HTMLButtonElement, text = el.querySelector("[data-label]")!.textContent?.trim() || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    const ok = await copyText(text);
    b.innerHTML = icon(ok ? "check" : "x");
    b.title = ok ? "Copied" : "Couldn't copy: select the text instead";
    setTimeout(() => { b.innerHTML = icon("copy"); b.title = "Copy the address"; }, 1500);
  };
  el.querySelector<HTMLElement>("[data-options]")!.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-name]"); if (!b) return;
    nameInput.value = b.dataset.name!;
    for (const x of $$("[data-name]", el)) x.classList.toggle("on", x === b);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = nameInput.value.trim(); if (!name) return;
    const pos = { lat: +latlng.lat.toFixed(5), lng: +latlng.lng.toFixed(5) };
    const desc = field("desc").value.trim();
    map!.closePopup();
    if (it) addStop(+daySelect.value, { time: timeInput.value || defaultTime(+daySelect.value), place: name, description: desc, fromList: !!preset.fromList, ...pos });
    else addCustomPlace({ title: name, note: desc, address, ...pos });
  };
  setTimeout(() => nameInput.focus(), 50);
}
