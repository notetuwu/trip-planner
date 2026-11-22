// Light, dark, or following the system: a button in the header cycles through them (saved in this browser).
// index.html sets the theme before the first paint; this keeps it up to date.
import { drawMap } from "../map/draw";
import { $ } from "./dom";
import { type IconName, icon } from "./icons";

export type Choice = "system" | "light" | "dark";
const KEY = "trip-planner-theme";
const NEXT: Record<Choice, Choice> = { system: "light", light: "dark", dark: "system" };
const LOOK: Record<Choice, [IconName, string]> = {
  system: ["monitor", "Theme: follows your system"], light: ["sun", "Theme: light"], dark: ["moon", "Theme: dark"],
};
const dark = matchMedia("(prefers-color-scheme: dark)");

export const choice = (): Choice => { const c = localStorage.getItem(KEY); return c === "light" || c === "dark" ? c : "system"; };

function apply() {
  const c = choice();
  const theme = c === "system" ? (dark.matches ? "dark" : "light") : c;
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  const btn = $("#themeBtn"), [name, label] = LOOK[c];
  btn.innerHTML = icon(name);
  btn.title = `${label} (click to change)`;
  btn.setAttribute("aria-label", label);
  if (changed) drawMap(); // pins and routes take their colours from the theme
}

export function initTheme() {
  apply();
  $("#themeBtn").onclick = () => { localStorage.setItem(KEY, NEXT[choice()]); apply(); };
  dark.addEventListener("change", apply);
}

/** Sets the theme (Settings → General). */
export function setTheme(c: Choice) { localStorage.setItem(KEY, c); apply(); }
