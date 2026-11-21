import { $ } from "../core/dom";

/** The small "Locating 3 places…" pill in the map's corner; empty hides it. */
export function setMapStatus(msg: string) {
  const el = $("#mapStatus");
  el.hidden = !msg;
  el.textContent = msg;
}
