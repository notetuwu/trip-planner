// The simple inputs (budget, currency, travelers, pace, model, interests, notes), bound to the trip state.
import { $ } from "../core/dom";
import { CURRENCIES } from "../core/format";
import { type AppState, save, state } from "../core/state";
import { renderChips } from "../places/chips";
import { renderTripTitle } from "./title";

export const FIELDS = ["dailyBudget", "currency", "travelers", "pace", "model", "interests", "notes"] as const;
type Field = (typeof FIELDS)[number];

const input = (f: Field) => $<HTMLInputElement>("#" + f);

/** Puts the trip's values into the inputs (after loading a trip). */
export function fillFields() {
  for (const f of FIELDS) input(f).value = String(state[f]);
}

export function initFields() {
  $("#currency").innerHTML = CURRENCIES.map((c) => `<option>${c}</option>`).join("");
  fillFields();
  for (const f of FIELDS) {
    const el = input(f);
    el.addEventListener("input", () => {
      (state as unknown as Record<Field, string | number>)[f] = el.type === "number" ? +el.value : el.value;
      save();
      if (f === "travelers") { renderChips(); renderTripTitle(); }
    });
  }
}

/** The trip fields sent with a generation request. */
export const fieldValues = () => Object.fromEntries(FIELDS.map((f) => [f, state[f]])) as Pick<AppState, Field>;
