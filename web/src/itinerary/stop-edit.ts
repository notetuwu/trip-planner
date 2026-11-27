// "Edit" on a stop: everything about it in one window. When it is, what it's called, what it is and what to know, what it
// costs and whether to book, its website, how they get there (the words, and the way on the map), the split group it
// belongs to, and where it is. Save keeps it all at once; a click outside, Escape or Cancel changes nothing.
import type { ItineraryItem } from "../../../shared/types";
import { closeOnBackdrop, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { byTitleMap, geocodeItems, itemLoc } from "../geo/item-loc";
import { company } from "../../../shared/people";
import { drawMap } from "../map/draw";
import { moveStopTo, removeStop } from "../map/edit";
import { fmtDate } from "../core/format";
import { moveToTime } from "./journey-model";
import { legControls } from "./leg-edit";
import { openPin } from "./pin";
import { renderItinerary } from "./render";

const KINDS: [NonNullable<ItineraryItem["kind"]>, string][] = [["sight", "Sight"], ["activity", "Activity"], ["meal", "Meal"], ["transfer", "Travel (a ride or transfer)"], ["other", "Other"]];
const BOOKING: [string, string][] = [["", "No need to book"], ["optional", "Optional"], ["recommended", "Recommended"], ["essential", "Essential (sells out)"]];

const opts = (list: [string, string][], sel = "") => list.map(([k, t]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(t)}</option>`).join("");

/** Opens the window for one stop; "leg" opens it at how they get there (the route button on the stop). */
export function openStopEdit(di: number, xi: number, focus?: "leg") {
  const d = state.itinerary?.days[di], x = d?.items[xi];
  if (!d || !x) return;
  const loc = itemLoc(x, d, byTitleMap());
  const travelers = Number(state.travelers) || 1;
  const dlg = document.createElement("dialog");
  dlg.className = "keys-dialog stop-edit";
  dlg.innerHTML = `<div class="se-head"><h3>${icon("pencil")} Edit stop</h3><span class="hint">Day ${di + 1} · stop ${xi + 1}</span><button type="button" class="icon-btn" data-se-close title="Close">${icon("x")}</button></div>
    <div class="se-body">
      <label class="se-f"><span>Day</span><select data-f="day">${state.itinerary!.days.map((o, k) => `<option value="${k}"${k === di ? " selected" : ""}>Day ${k + 1} · ${esc(fmtDate(o.date) || o.date)} · ${esc(o.city.split(",")[0])}</option>`).join("")}</select></label>
      <div class="se-row se-time-name">
        <label class="se-f se-time"><span>Time</span><input type="time" data-f="time" value="${esc(/^\d{1,2}:\d{2}/.test(x.time || "") ? x.time.slice(0, 5).padStart(5, "0") : "")}"></label>
        <label class="se-f se-grow"><span>Name</span><input type="text" data-f="place" value="${esc(x.place)}" required></label>
      </div>
      <div class="se-row">
        <label class="se-f"><span>What it is</span><select data-f="kind">${opts([["", "—"], ...KINDS], x.kind || "")}</select></label>
        <label class="se-check"><input type="checkbox" data-f="mustSee"${x.mustSee ? " checked" : ""}> One of our must-sees</label>
      </div>
      <label class="se-f"><span>Description</span><textarea data-f="description" rows="4">${esc(x.description || "")}</textarea></label>
      <div class="se-row">
        <label class="se-f"><span>Cost <small>(${esc(state.currency || "")} for the group)</small></span><input type="number" min="0" step="0.01" data-f="cost" value="${x.cost != null ? esc(x.cost) : ""}" placeholder="0"></label>
        <label class="se-f se-grow"><span>The cost…</span><select data-f="costPer">${opts([["", "—"], ["person", "grows with the number of travelers"], ["group", "is the same for the whole group"]], x.costPer || "")}</select></label>
      </div>
      <div class="se-row">
        <label class="se-f"><span>Booking</span><select data-f="booking">${opts(BOOKING, x.booking || "")}</select></label>
        <label class="se-f se-grow"><span>How far ahead</span><input type="text" data-f="bookAhead" value="${esc(x.bookAhead || "")}" placeholder="e.g. 2-3 weeks before"></label>
      </div>
      <label class="se-f"><span>Where</span><input data-f="where" value="${esc(x.where || "")}" placeholder="Venue or address, when the name isn't the place (e.g. Shibuya BEAM, Shibuya)"></label>
      <label class="se-f"><span>Website</span><input type="url" data-f="website" value="${esc(x.website || "")}" placeholder="https://"></label>
      <fieldset class="se-section"><legend>${icon("route")} Getting here</legend>
        <label class="se-f"><span>In words</span><textarea data-f="transport" rows="2" placeholder="e.g. Midosuji Line to Shinsaibashi, then 5 min on foot">${esc(x.transport || "")}</textarea></label>
        <div class="se-leg"></div>
      </fieldset>
      ${state.people?.length ? `<fieldset class="se-section"><legend>${icon("users")} Who goes <small>(all ticked or none: everyone)</small></legend><div class="se-row se-who">
        ${[...new Set([...state.people, ...(x.who || [])])].map((n) => `<label class="inline-check"><input type="checkbox" data-who="${esc(n)}"${!x.who?.length || x.who.includes(n) ? " checked" : ""}> ${esc(n)}</label>`).join("")}
      </div></fieldset>` : travelers > 1 ? `<fieldset class="se-section"><legend>${icon("users")} Who goes</legend><div class="se-row">
        <label class="se-f se-grow"><span>Group <small>(empty: everyone)</small></span><input type="text" data-f="group" value="${esc(x.group || "")}" placeholder="e.g. Group A"></label>
        <label class="se-f"><span>How many</span><input type="number" min="1" max="${travelers - 1}" data-f="people" value="${x.group && x.people ? esc(x.people) : ""}"></label>
      </div></fieldset>` : ""}
      <div class="se-where">${icon("pin")} <span>${loc ? `${x.pinned ? "Set by hand" : loc.approx ? "Only estimated" : "Found on the map"}` : "Not on the map"}</span><button type="button" class="link-btn" data-se-pin>${icon("crosshair")} ${loc ? "Change where it is" : "Set where it is"}</button></div>
    </div>
    <div class="se-acts"><button type="button" class="link-btn danger" data-se-del>${icon("x")} Remove stop</button><span class="se-gap"></span><button type="button" class="btn" data-se-cancel>Cancel</button><button type="button" class="btn solid" data-se-save>Save</button></div>`;
  document.body.append(dlg);
  closeOnBackdrop(dlg);
  const leg = legControls(dlg.querySelector<HTMLElement>(".se-leg")!, di, xi);
  const field = <T extends HTMLElement = HTMLInputElement>(f: string) => dlg.querySelector<T>(`[data-f="${f}"]`);
  const close = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());

  const saveAll = () => {
    const name = field("place")!.value.trim();
    if (!name) { field("place")!.focus(); return; }
    const text = (f: string) => (field<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(f)?.value ?? "").trim();
    const set = <K extends keyof ItineraryItem>(k: K, v: ItineraryItem[K] | "" | undefined) => { if (v === "" || v === undefined) delete x[k]; else x[k] = v as ItineraryItem[K]; };
    const retimed = text("time") !== (field("time")!.defaultValue || "");
    x.time = text("time"); x.place = name; x.description = text("description");
    set("kind", text("kind") as ItineraryItem["kind"] | "");
    const cost = text("cost");
    set("cost", cost === "" ? undefined : Math.max(0, Number(cost) || 0));
    set("costPer", text("costPer") as ItineraryItem["costPer"] | "");
    set("booking", text("booking") as ItineraryItem["booking"] | "");
    set("bookAhead", text("booking") ? text("bookAhead") : "");
    set("website", text("website"));
    set("where", text("where"));
    set("mustSee", field("mustSee")!.checked || undefined);
    // Their own words for getting here replace the timetable's (and the plan's) from now on.
    const transport = text("transport");
    if (transport !== (x.transport || "")) { set("transport", transport); delete x.transportWas; }
    if (state.people?.length) {
      const boxes = [...dlg.querySelectorAll<HTMLInputElement>("[data-who]")], who = company(boxes.filter((b) => b.checked).map((b) => b.dataset.who!), state.people, travelers);
      set("who", who.length ? who : undefined);
      // (Said by name now: a group label from before goes.)
      if (who.length || boxes.length) { delete x.group; delete x.people; }
    } else if (travelers > 1) {
      const group = text("group");
      set("group", group);
      set("people", group ? Math.min(travelers - 1, Math.max(1, Number(text("people")) || 1)) : undefined);
    }
    const l = leg.read();
    if (l) x.leg = l; else delete x.leg;
    // The day's total follows the costs.
    d.estimatedCost = d.items.reduce((n, y) => n + (Number(y.cost) || 0), 0);
    // A new time puts it in its place in the day (after the leg fields are read, which go by its old place).
    moveToTime(d.items, x, retimed);
    close();
    // Another day: moved there in its time order (with its own toast and Undo).
    const toDi = Number(text("day"));
    if (Number.isInteger(toDi) && toDi !== di && state.itinerary!.days[toDi]) { moveStopTo(di, d.items.indexOf(x), toDi); geocodeItems(); return; }
    save(); renderItinerary(); drawMap({ fit: false });
    geocodeItems(); // a new "where" is looked up
    toast(`Saved “${x.place}”`);
  };

  dlg.querySelector<HTMLButtonElement>("[data-se-save]")!.onclick = saveAll;
  dlg.querySelector<HTMLButtonElement>("[data-se-cancel]")!.onclick = close;
  dlg.querySelector<HTMLButtonElement>("[data-se-close]")!.onclick = close;
  dlg.querySelector<HTMLButtonElement>("[data-se-del]")!.onclick = () => { close(); removeStop(di, xi); };
  // Where it is: the usual "where is it?" panel under the stop (search nearby, or click the map).
  dlg.querySelector<HTMLButtonElement>("[data-se-pin]")!.onclick = () => {
    close();
    const btn = document.querySelector<HTMLElement>(`[data-pin="${di}-${xi}"]`);
    if (btn) { btn.scrollIntoView({ block: "center" }); openPin(di, xi, btn); }
  };
  // Enter in a one-line field saves (not in the boxes of several lines, nor in the search for places on the way).
  dlg.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.tagName === "INPUT" && t.closest(".se-body") && !t.closest(".se-leg") && (t as HTMLInputElement).type !== "checkbox") { e.preventDefault(); saveAll(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveAll(); }
  });
  dlg.showModal();
  if (focus === "leg") { const sec = dlg.querySelector<HTMLElement>(".se-leg")!; sec.closest("fieldset")!.scrollIntoView({ block: "start" }); sec.querySelector<HTMLInputElement>("input:checked")?.focus(); }
  else field("place")!.focus();
}
