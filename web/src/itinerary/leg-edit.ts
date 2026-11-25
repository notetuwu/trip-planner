// "How you get here" on a stop: the way from the stop before, set by hand when the map reads it wrong from the
// transport text. A mode for each part, through places on the way ("train down to Vitznau, then the boat back").
// The controls go in the stop's edit window (see stop-edit.ts).
import type { GeoHit, ItineraryItem, LegChoice } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { icon } from "../core/icons";
import { state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";
import { dayLegs, legStart } from "../map/routes";

const CHOICES: [LegChoice, string][] = [
  ["foot", "On foot"], ["bike", "By bike"], ["car", "By car or taxi"], ["bus", "By bus (its line, else the road)"], ["transit", "By tram or metro"],
  ["train", "By train or cog railway"], ["ferry", "By boat"], ["lift", "Cable car, gondola or funicular"], ["flight", "Flight"],
  ["straight", "Straight line (no route)"],
];

type Leg = NonNullable<ItineraryItem["leg"]>;

/** The way to a stop, editable in `host`: automatic (read from the transport text) or set by hand, a mode per part.
 *  read() gives the leg to keep (null: automatic). */
export function legControls(host: HTMLElement, di: number, xi: number) {
  const d = state.itinerary!.days[di], x = d.items[xi];
  const byTitle = byTitleMap();
  // Where the leg starts: the stop before it on the map (the one the leg is drawn from).
  const legs = dayLegs(d, byTitle).filter((l) => l.xi === xi);
  const fromName = legs.length ? legStart(d, legs[0]) : "";
  // Starts from what's set, else from how the map reads it now.
  const now: LegChoice = !legs[0] ? "straight" : legs[0].bus ? "bus" : legs[0].mode;
  const draft: Leg = x.leg ? structuredClone(x.leg) : { modes: [now], via: [] };
  let byHand = !!x.leg;
  const near = itemLoc(x, d, byTitle) || (stayOn(d) ? stayLoc(stayOn(d)!) : undefined);

  const render = () => {
    const options = (sel: LegChoice) => CHOICES.map(([k, t]) => `<option value="${k}"${k === sel ? " selected" : ""}>${t}</option>`).join("");
    const rows = draft.modes.map((m, k) => `<li class="lp-row">
        <select data-mode="${k}" aria-label="How">${options(m)}</select>
        <span>to <b>${esc(k < draft.via.length ? draft.via[k].name : x.place)}</b></span>
        ${k < draft.via.length ? `<button type="button" class="icon-btn" data-unvia="${k}" title="Not through here">${icon("x")}</button>` : ""}
      </li>`).join("");
    host.innerHTML = `<div class="lp-how">
        <label><input type="radio" name="lp-how-${di}-${xi}" value="auto"${byHand ? "" : " checked"}> Automatic <span class="hint">· read from the transport text${legs[0] ? ` (now: ${esc(CHOICES.find(([k]) => k === now)?.[1].toLowerCase() || now)})` : ""}</span></label>
        <label><input type="radio" name="lp-how-${di}-${xi}" value="hand"${byHand ? " checked" : ""}> Set by hand${fromName ? ` <span class="hint">· from ${esc(fromName)}</span>` : ""}</label>
      </div>
      <div class="lp-hand"${byHand ? "" : " hidden"}>
        <ol class="lp-rows">${rows}</ol>
        <form class="pin-search"><input type="search" placeholder="Add a stop on the way, e.g. Vitznau"><button class="btn">Add</button></form>
        <ul class="pin-results"></ul>
      </div>`;
    host.querySelectorAll<HTMLInputElement>(`input[name="lp-how-${di}-${xi}"]`).forEach((r) => { r.onchange = () => { byHand = r.value === "hand"; render(); }; });
    host.querySelectorAll<HTMLSelectElement>("[data-mode]").forEach((s) => { s.onchange = () => { draft.modes[+s.dataset.mode!] = s.value as LegChoice; }; });
    host.querySelectorAll<HTMLButtonElement>("[data-unvia]").forEach((b) => { b.onclick = () => { const k = +b.dataset.unvia!; draft.via.splice(k, 1); draft.modes.splice(k, 1); render(); }; });
    const input = host.querySelector<HTMLInputElement>(".lp-hand input")!, list = host.querySelector<HTMLElement>(".lp-hand .pin-results")!;
    host.querySelector<HTMLFormElement>(".lp-hand form")!.onsubmit = async (e) => {
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
  render();
  return { read: (): Leg | null => (byHand ? draft : null) };
}
