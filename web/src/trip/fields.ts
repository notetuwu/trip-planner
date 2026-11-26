// The simple inputs (budget, currency, travelers, pace, model, interests, notes), bound to the trip state.
import { $ } from "../core/dom";
import { CURRENCIES } from "../core/format";
import { type AppState, save, state } from "../core/state";
import { renderChips } from "../places/chips";
import { cleanNames } from "../../../shared/people";
import { renderTripTitle } from "./title";

export const FIELDS = ["dailyBudget", "currency", "travelers", "pace", "fitness", "dayStart", "breakfast", "getAround", "model", "interests", "wishes", "notes"] as const;
type Field = (typeof FIELDS)[number];

const input = (f: Field) => $<HTMLInputElement>("#" + f);

const WISHES: [Field, string][] = [["interests", "interests"], ["wishes", "what to see"], ["notes", "notes"]];
/** The "Your wishes" fold's line: what's filled in ("interests, notes"), or that nothing is yet. */
function wishesHint() {
  const filled = WISHES.filter(([f]) => String(state[f] || "").trim()).map(([, label]) => label);
  $("#wishesHint").textContent = filled.length ? filled.join(", ") : "interests, what to see, anything else";
  return filled.length;
}

/** Puts the trip's values into the inputs (after loading a trip). */
export function fillFields() {
  for (const f of FIELDS) input(f).value = String(state[f] ?? (f === "fitness" ? "average" : ""));
  showNames();
  // Open when nothing is filled in yet, so a new trip shows the boxes; closed (one line) once there's something.
  $<HTMLDetailsElement>("#wishesFold").open = wishesHint() === 0;
}

/** The travelers' names, as one line ("Me, Anna"); the line is only there when more than one travels. */
export function showNames() {
  const el = $<HTMLInputElement>("#people");
  if (document.activeElement !== el) el.value = (state.people || []).join(", ");
  $("#namesRow").hidden = !(Number(state.travelers) > 1 || state.people?.length);
}

/** Called after the names change (the plan and the map group by them). */
let namesChanged = () => {};
export const onNames = (f: () => void) => { namesChanged = f; };

export function initFields() {
  $("#currency").innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join("");
  fillFields();
  for (const f of FIELDS) {
    const el = input(f);
    el.addEventListener("input", () => {
      if (f === "model" && el.value.startsWith("__")) return; // menu actions such as "Add API keys…", not models
      (state as unknown as Record<Field, string | number>)[f] = el.type === "number" ? +el.value : el.value;
      save();
      if (WISHES.some(([w]) => w === f)) wishesHint();
      if (f === "travelers") { showNames(); renderChips(); renderTripTitle(); }
    });
  }
  const names = $<HTMLInputElement>("#people");
  names.addEventListener("change", () => {
    const list = cleanNames(names.value);
    if (list.length) state.people = list; else delete state.people;
    // More names than travelers: that many travel.
    if (list.length > (Number(state.travelers) || 1)) { state.travelers = list.length; $<HTMLInputElement>("#travelers").value = String(list.length); renderTripTitle(); }
    names.value = list.join(", ");
    save(); namesChanged();
  });
}

/** The trip fields sent with a generation request. */
export const fieldValues = () => Object.fromEntries(FIELDS.map((f) => [f, state[f]])) as Pick<AppState, Field>;
