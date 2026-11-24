// "How you get here" on a stop: the way from the stop before, set by hand when the map reads it wrong from the
// transport text. A mode for each part, through places on the way ("train down to Vitznau, then the boat back").
import type { GeoHit, LegChoice } from "../../../shared/types";
import { api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";
import { drawMap } from "../map/draw";
import { dayLegs, legStart } from "../map/routes";
import { renderItinerary } from "./render";

const CHOICES: [LegChoice, string][] = [
  ["foot", "On foot"], ["bike", "By bike"], ["car", "By car or taxi"], ["bus", "By bus (its line, else the road)"], ["transit", "By tram or metro"],
  ["train", "By train or cog railway"], ["ferry", "By boat"], ["lift", "Cable car, gondola or funicular"], ["flight", "Flight"],
  ["straight", "Straight line (no route)"],
];

/** Opens the panel under the stop. */
export function openLegEdit(di: number, xi: number, anchor: HTMLElement) {
  document.querySelector(".leg-panel")?.remove();
  const d = state.itinerary?.days[di], x = d?.items[xi];
  if (!d || !x) return;
  const byTitle = byTitleMap();
  // Where the leg starts: the stop before it on the map (the one the leg is drawn from).
  const legs = dayLegs(d, byTitle).filter((l) => l.xi === xi);
  const fromName = legs.length ? legStart(d, legs[0]) : "";
  // Starts from what's set, else from how the map reads it now.
  const now: LegChoice = !legs[0] ? "straight" : legs[0].bus ? "bus" : legs[0].mode;
  const draft: NonNullable<typeof x.leg> = x.leg ? structuredClone(x.leg) : { modes: [now], via: [] };
  const near = itemLoc(x, d, byTitle) || (stayOn(d) ? stayLoc(stayOn(d)!) : undefined);

  const panel = document.createElement("div");
  panel.className = "pin-panel leg-panel";
  anchor.closest("li.item")?.appendChild(panel);

  const render = () => {
    const options = (sel: LegChoice) => CHOICES.map(([k, t]) => `<option value="${k}"${k === sel ? " selected" : ""}>${t}</option>`).join("");
    const rows = draft.modes.map((m, k) => `<li class="lp-row">
        <select data-mode="${k}" aria-label="How">${options(m)}</select>
        <span>to <b>${esc(k < draft.via.length ? draft.via[k].name : x.place)}</b></span>
        ${k < draft.via.length ? `<button type="button" class="icon-btn" data-unvia="${k}" title="Not through here">${icon("x")}</button>` : ""}
      </li>`).join("");
    panel.innerHTML = `<div class="pin-head"><b>How you get here${fromName ? ` from ${esc(fromName)}` : ""}</b><button type="button" class="icon-btn" data-close title="Close">${icon("x")}</button></div>
      <ol class="lp-rows">${rows}</ol>
      <form class="pin-search"><input type="search" placeholder="Add a stop on the way, e.g. Vitznau"><button class="btn">Add</button></form>
      <ul class="pin-results"></ul>
      <div class="lp-acts"><button type="button" class="btn solid" data-save>Save</button>${x.leg ? `<button type="button" class="link-btn" data-auto title="Read it from the transport text again">Back to automatic</button>` : ""}</div>`;
    panel.querySelectorAll<HTMLSelectElement>("[data-mode]").forEach((s) => { s.onchange = () => { draft.modes[+s.dataset.mode!] = s.value as LegChoice; }; });
    panel.querySelectorAll<HTMLButtonElement>("[data-unvia]").forEach((b) => { b.onclick = () => { const k = +b.dataset.unvia!; draft.via.splice(k, 1); draft.modes.splice(k, 1); render(); }; });
    panel.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => panel.remove();
    panel.querySelector<HTMLButtonElement>("[data-save]")!.onclick = () => done(draft);
    const auto = panel.querySelector<HTMLButtonElement>("[data-auto]");
    if (auto) auto.onclick = () => done(null);
    const input = panel.querySelector<HTMLInputElement>("input")!, list = panel.querySelector<HTMLElement>(".pin-results")!;
    panel.querySelector("form")!.onsubmit = async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      list.innerHTML = `<li class="hint">Searching…</li>`;
      try {
        const params = new URLSearchParams({ q, ...(near ? { lat: near.lat.toFixed(4), lng: near.lng.toFixed(4) } : {}) });
        const hits = await api<GeoHit[]>(`/api/search?${params}`);
        list.innerHTML = hits.length ? hits.slice(0, 6).map((h, i) => `<li><button type="button" data-hit="${i}"><b>${esc(h.name || h.label.split(",")[0])}</b><small>${esc(h.label)}</small></button></li>`).join("")
          : `<li class="hint">Nothing found. Try the town's name.</li>`;
        // The new place goes last on the way (just before this stop); its part goes by the same mode as the last one did.
        list.querySelectorAll<HTMLButtonElement>("[data-hit]").forEach((b) => {
          b.onclick = () => {
            const h = hits[+b.dataset.hit!];
            draft.via.push({ name: h.name || h.label.split(",")[0], lat: h.lat, lng: h.lng });
            draft.modes.splice(draft.modes.length - 1, 0, draft.modes[draft.modes.length - 1]);
            render();
          };
        });
      } catch (err) { list.innerHTML = `<li class="hint">${esc((err as Error).message)}</li>`; }
    };
  };

  const done = (leg: typeof draft | null) => {
    if (leg) x.leg = leg; else delete x.leg;
    panel.remove();
    save(); renderItinerary(); drawMap({ fit: false });
    toast(leg ? `How you get to ${x.place} is set` : `${x.place}: read from the transport text again`);
  };

  render();
}
