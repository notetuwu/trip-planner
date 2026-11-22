// Light, dark, or following the system: chosen in Settings → General (saved in this browser).
// index.html sets the theme before the first paint; this keeps it up to date.
import { drawMap } from "../map/draw";

export type Choice = "system" | "light" | "dark";
const KEY = "trip-planner-theme";
const dark = matchMedia("(prefers-color-scheme: dark)");

export const choice = (): Choice => { const c = localStorage.getItem(KEY); return c === "light" || c === "dark" ? c : "system"; };

function apply() {
  const c = choice();
  const theme = c === "system" ? (dark.matches ? "dark" : "light") : c;
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  if (changed) drawMap(); // pins and routes take their colours from the theme
}

export function initTheme() {
  apply();
  dark.addEventListener("change", apply);
}

/** Sets the theme (Settings → General). */
export function setTheme(c: Choice) { localStorage.setItem(KEY, c); apply(); }
