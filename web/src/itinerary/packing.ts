// A packing list worked out from the trip itself (no AI): sockets for the countries, clothes for the forecast or the
// season, gear for what's planned (mountains, hikes, onsen, churches), and documents for how you travel. Ticked items
// and your own additions are saved with the trip.
import type { Itinerary } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { save, session, state } from "../core/state";
import { stayLoc } from "../geo/locate";

/** Socket types by country (the common ones; Europe mostly uses C/E/F). */
const PLUGS: Record<string, string> = {
  JP: "A/B", US: "A/B", CA: "A/B", MX: "A/B", TW: "A/B", TH: "A/B/C/O", KR: "C/F", CN: "A/C/I", HK: "G", SG: "G", MY: "G",
  GB: "G", IE: "G", MT: "G", CY: "G", CH: "J", LI: "J", IT: "L/F", DK: "K/F", AU: "I", NZ: "I", IN: "C/D/M", IL: "H/C",
  ZA: "M/N", BR: "N/C", AR: "I", VN: "A/C", ID: "C/F", PH: "A/B", TR: "F", IS: "F", NO: "F", SE: "F", FI: "F",
};
const EURO_PLUGS = "C/E/F";
const VIGNETTE = new Set(["AT", "CH", "SI", "CZ", "SK", "HU", "BG", "RO"]);
const EHIC = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CH"]);

export interface PackGroup { title: string; items: { text: string; why?: string }[] }

/** The suggested list for the current trip. */
export function packingList(it: Itinerary): PackGroup[] {
  const countries = [...new Map(state.stays.map(stayLoc).filter((l) => l?.cc).map((l) => [l!.cc.toUpperCase(), l!.country || l!.cc])).entries()];
  const ccs = new Set(countries.map(([cc]) => cc));
  const text = it.days.flatMap((d) => [d.title, d.city, d.notes || "", ...d.items.map((x) => `${x.place} ${x.description} ${x.transport || ""}`)]).join(" ").toLowerCase();
  const has = (re: RegExp) => re.test(text);
  const driving = state.stays.some((s) => s.travel === "car" || (s.dayTrips || []).some((t) => t.mode === "car")) || has(/\b(drive|driving|rental car|by car)\b/);

  // Weather: the forecast where there is one, otherwise the season (northern or southern hemisphere).
  const forecast = it.days.map((d) => session.weather[d.date]).filter(Boolean);
  const lat = stayLoc(state.stays[0])?.lat ?? 45;
  const month = Number((state.stays.find((s) => s.start)?.start || it.days[0]?.date || "").slice(5, 7)) || 6;
  const m = lat < 0 ? ((month + 5) % 12) + 1 : month; // the same season's month in the northern hemisphere
  const warm = forecast.length ? Math.max(...forecast.map((w) => w.max)) >= 24 : m >= 5 && m <= 9;
  const cold = forecast.length ? Math.min(...forecast.map((w) => w.min)) <= 8 : m >= 11 || m <= 3;
  const rain = forecast.length ? forecast.some((w) => w.code >= 51) : true;
  const mountains = has(/\b(mount|mt\.|alp|alps|summit|peak|gipfel|glacier|gletscher|cable car|gondola|seilbahn|ropeway|pilatus|hike|hiking|trail)\b/);

  const plugs = countries.map(([cc, name]) => `${name} ${PLUGS[cc] || EURO_PLUGS}`);
  const groups: PackGroup[] = [
    { title: "Documents & money", items: [
      { text: "Passport or ID card" },
      ...(driving ? [{ text: "Driving licence", why: "you drive" }] : []),
      ...(driving && [...ccs].some((cc) => VIGNETTE.has(cc)) ? [{ text: "Motorway vignette", why: `needed in ${countries.filter(([cc]) => VIGNETTE.has(cc)).map(([, n]) => n).join(", ")}; buy online before` }] : []),
      ...([...ccs].some((cc) => EHIC.has(cc)) ? [{ text: "European health insurance card (EHIC)" }] : []),
      { text: "Travel insurance details" },
      { text: "Bank card and some cash" },
      ...(ccs.has("JP") ? [{ text: "Cash in yen", why: "many small places don't take cards" }, { text: "IC card (Suica/ICOCA) on your phone", why: "trains, buses, shops" }] : []),
      ...(it.days.some((d) => d.items.some((x) => x.booking === "essential" || x.booking === "recommended")) ? [{ text: "Tickets and reservations", why: "see Book ahead" }] : []),
    ] },
    { title: "Electronics", items: [
      { text: "Phone and charger" }, { text: "Power bank" },
      { text: `Plug adapter if needed: ${plugs.join(", ")}`, why: "socket types" },
      ...(it.days.length > 7 ? [{ text: "Charging cable spares" }] : []),
    ] },
    { title: "Clothes", items: [
      ...(warm ? [{ text: "Light clothes, sun hat" }] : []),
      ...(cold ? [{ text: "Warm jacket" }] : [{ text: "Light jacket or sweater for the evenings" }]),
      ...(rain ? [{ text: "Rain jacket or umbrella", why: forecast.length ? "rain in the forecast" : "it may rain" }] : []),
      ...(mountains ? [{ text: "Warm layer for the mountains", why: "it's colder up top" }, { text: "Sturdy shoes", why: "hikes or mountain paths" }] : [{ text: "Comfortable walking shoes" }]),
      ...(has(/\b(church|cathedral|duomo|basilica|temple|shrine|mosque|kirche|dom)\b/) ? [{ text: "Clothes covering shoulders and knees", why: "churches and temples" }] : []),
      ...(ccs.has("JP") ? [{ text: "Socks without holes", why: "shoes come off in temples and ryokan" }] : []),
      ...(has(/\b(beach|swim|swimming|pool|spa|therme|thermal|onsen|bath|lido)\b/) ? [{ text: "Swimwear", why: "swimming, spa or onsen planned" }] : []),
    ] },
    { title: "Toiletries & health", items: [
      { text: "Toiletries" }, { text: "Medication and a small first-aid kit" },
      ...(warm || mountains ? [{ text: "Sunscreen and sunglasses" }] : []),
      ...(has(/\bonsen\b/) ? [{ text: "Small towel", why: "onsen" }] : []),
    ] },
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter((i, k, a) => a.findIndex((j) => j.text === i.text) === k) }));
}

export function packingHtml(it: Itinerary) {
  const packed = state.packed || {}, extra = state.packingExtra || [];
  const groups = packingList(it);
  const all = [...groups.flatMap((g) => g.items.map((i) => i.text)), ...extra];
  const done = all.filter((t) => packed[t]).length;
  const row = (text: string, why?: string, own = false) => `<li><label><input type="checkbox" data-packed="${esc(text)}" ${packed[text] ? "checked" : ""}>
      <span>${esc(text)}${why ? ` <span class="hint">· ${esc(why)}</span>` : ""}</span></label>${own ? `<button class="icon-btn" data-unpack="${esc(text)}" title="Remove">×</button>` : ""}</li>`;
  return `<details class="packing fold" data-fold="packing">
    <summary><h2>Packing list</h2><span class="hint">${done} of ${all.length} packed · from your trip's countries, weather and plans</span></summary>
    <div class="packing-groups">${groups.map((g) => `<div><div class="ahead-sub">${esc(g.title)}</div><ul>${g.items.map((i) => row(i.text, i.why)).join("")}</ul></div>`).join("")}
      <div><div class="ahead-sub">Your own</div><ul>${extra.map((t) => row(t, undefined, true)).join("")}</ul>
        <form class="pack-add"><input placeholder="Add an item…" maxlength="80"><button class="btn">Add</button></form></div>
    </div>
  </details>`;
}

export function wirePacking(root: HTMLElement, rerender: () => void) {
  for (const box of $$<HTMLInputElement>("[data-packed]", root)) box.onchange = () => {
    state.packed = { ...state.packed, [box.dataset.packed!]: box.checked };
    if (!box.checked) delete state.packed[box.dataset.packed!];
    save();
  };
  for (const b of $$<HTMLButtonElement>("[data-unpack]", root)) b.onclick = () => {
    state.packingExtra = (state.packingExtra || []).filter((t) => t !== b.dataset.unpack);
    save(); rerender();
  };
  const form = root.querySelector<HTMLFormElement>(".pack-add");
  if (form) form.onsubmit = (e) => {
    e.preventDefault();
    const text = form.querySelector("input")!.value.trim();
    if (text && !(state.packingExtra || []).includes(text)) { state.packingExtra = [...(state.packingExtra || []), text]; save(); rerender(); }
  };
}
