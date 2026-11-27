// A menu under a button (Export in the plan's toolbar: each choice with its icon, its name and a line on what it does;
// or a picker with a layout of its own, as "Show prices in"). A popover, so nothing around it cuts it off; under the button, or above it when there's more room there. Arrow keys
// move, Enter picks, Esc or a click outside closes; the button closes it again.
import { esc } from "./dom";
import { type IconName, icon } from "./icons";

export interface MenuItem { id: string; icon: IconName; label: string; hint?: string; run: () => void }

let open: { el: HTMLElement; anchor: HTMLElement } | null = null;
let closedAt = { anchor: null as HTMLElement | null, at: 0 };

/** Opens the menu at a button, or closes it when it's that button's menu that's open. */
export function toggleMenu(anchor: HTMLElement, items: MenuItem[]) {
  togglePopup(anchor, {
    className: "menu-pop",
    html: items.map((x) => `<button type="button" role="menuitem" class="menu-item" data-menu-item="${esc(x.id)}">${icon(x.icon)}<span><b>${esc(x.label)}</b>${x.hint ? `<small>${esc(x.hint)}</small>` : ""}</span></button>`).join(""),
    pick: (_, i) => items[i].run(),
  });
}

interface Popup { className: string; html: string; pick: (button: HTMLButtonElement, index: number) => void; end?: boolean }

/** The same for any content: its buttons are the choices (the one with aria-checked="true" gets the focus). In a
 *  dialog it opens inside it, or it couldn't be clicked. `end`: lined up with the button's right edge. */
export function togglePopup(anchor: HTMLElement, { className, html, pick, end }: Popup) {
  if (open?.anchor === anchor) { open.el.hidePopover(); return; }
  // (A press on the button has just closed it, as a click outside: don't open it again.)
  if (closedAt.anchor === anchor && Date.now() - closedAt.at < 400) return;
  open?.el.hidePopover();
  const el = document.createElement("div");
  el.className = className;
  el.popover = "auto";
  el.setAttribute("role", "menu");
  el.innerHTML = html;
  (anchor.closest("dialog") || document.body).append(el);
  const r = anchor.getBoundingClientRect(), below = innerHeight - r.bottom - 8, above = r.top - 8;
  el.showPopover();
  const h = el.offsetHeight, up = h > below && above > below, shownHeight = Math.min(h, (up ? above : below) - 6);
  Object.assign(el.style, { left: `${Math.max(8, Math.min(end ? r.right - el.offsetWidth : r.left, innerWidth - el.offsetWidth - 8))}px`, top: up ? `${Math.max(8, r.top - shownHeight - 6)}px` : `${r.bottom + 6}px`, maxHeight: `${shownHeight}px`, overflowY: "auto" });
  anchor.setAttribute("aria-expanded", "true");
  open = { el, anchor };
  const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
  buttons.forEach((b, i) => b.onclick = () => { el.hidePopover(); pick(b, i); });
  el.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (step) { e.preventDefault(); buttons[(i + step + buttons.length) % buttons.length].focus(); }
    if (e.key === "Home") { e.preventDefault(); buttons[0].focus(); }
    if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1].focus(); }
    if (e.key === "Tab") el.hidePopover();
  });
  el.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "closed") return;
    anchor.setAttribute("aria-expanded", "false");
    closedAt = { anchor, at: Date.now() };
    if (open?.el === el) open = null;
    el.remove();
    if (el.contains(document.activeElement) || document.activeElement === document.body) anchor.focus({ preventScroll: true });
  });
  (buttons.find((b) => b.getAttribute("aria-checked") === "true") || buttons[0])?.focus({ preventScroll: true });
}
