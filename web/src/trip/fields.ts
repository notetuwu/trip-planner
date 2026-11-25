// The simple inputs (budget, currency, travelers, pace, model, interests, notes), bound to the trip state.
import { $ } from "../core/dom";
import { CURRENCIES } from "../core/format";
import { type AppState, save, state } from "../core/state";
import { renderChips } from "../places/chips";
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
  // Open when nothing is filled in yet, so a new trip shows the boxes; closed (one line) once there's something.
  $<HTMLDetailsElement>("#wishesFold").open = wishesHint() === 0;
}

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
      if (f === "travelers") { renderChips(); renderTripTitle(); }
    });
  }
}

/** The trip fields sent with a generation request. */
export const fieldValues = () => Object.fromEntries(FIELDS.map((f) => [f, state[f]])) as Pick<AppState, Field>;
