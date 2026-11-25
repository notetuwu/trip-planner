// A trip someone else shared as view only (Settings → Sync), shown as such: its settings can't be changed, the plan's
// edit buttons are gone, nothing is saved into it (saves.ts), and a bar says whose it is with "Make my own copy". Their
// updates still come in. Viewing works as usual: the map, the days, photos, the preview, exports, the chat's answers.
import { $$, esc } from "../core/dom";
import { icon } from "../core/icons";

let shown = false;

/** Shows the trip on screen as view only (owner: who shared it), or as usual. `copy` makes the person's own copy. */
export function setReadOnly(on: boolean, owner = "", copy?: () => void) {
  const settings = document.querySelector<HTMLElement>("main > .settings");
  document.body.classList.toggle("read-only", on);
  // Everything in the trip's column except its header (Export, Import, New trip) and Browse trips.
  if (settings) for (const el of $$<HTMLElement>(":scope > *", settings)) {
    if (el.matches("h2, .trip-bar, #readOnlyBar")) continue;
    el.inert = on;
  }
  let bar = document.querySelector<HTMLElement>("#readOnlyBar");
  if (!on) { bar?.remove(); shown = false; return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "readOnlyBar"; bar.className = "read-only-bar";
    settings?.querySelector(".trip-bar")?.after(bar);
  }
  bar.innerHTML = `<b>${icon("eye")} View only</b><span>Shared by ${esc(owner)}. You see their changes as they make them; to change it yourself, make your own copy.</span>
    <button type="button" class="btn" data-own-copy>${icon("copy")} Make my own copy</button>`;
  bar.querySelector<HTMLButtonElement>("[data-own-copy]")!.onclick = () => copy?.();
  shown = true;
}

export const isReadOnly = () => shown;
