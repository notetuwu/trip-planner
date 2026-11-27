// A searchable picker in place of a long <select>: a search field that opens a list grouped under headings (the plan's
// days, say), filtered as they type by the items' text and their heading, with arrow keys, Enter to pick and Esc to close
// (without closing the dialog it's in). Once something is picked, the field shows it with ✕ to clear it. The list floats
// over what's below the field.
import { esc } from "./dom";
import { type IconName, icon } from "./icons";

export interface PickItem {
  value: string;
  label: string;
  /** The heading it's listed under. */
  group: string;
  /** Small text before it (a time) and after it (a price), and a tag ("paid"). */
  lead?: string;
  note?: string;
  tag?: string;
  icon?: IconName;
  /** More words it's found by (a town, a date). */
  words?: string;
}

export interface PickList { value: () => string; set: (v: string) => void }

/** Lower case, without accents, for matching ("Café" is found by "cafe"). */
export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The text with what was searched for marked. */
function marked(text: string, words: string[]) {
  if (!words.length) return esc(text);
  const f = fold(text);
  const hits: [number, number][] = [];
  for (const w of words) { let i = f.indexOf(w); while (i >= 0) { hits.push([i, i + w.length]); i = f.indexOf(w, i + w.length); } }
  if (!hits.length) return esc(text);
  hits.sort((a, b) => a[0] - b[0]);
  let out = "", at = 0;
  for (const [a, b] of hits) { if (a < at) continue; out += esc(text.slice(at, a)) + `<mark>${esc(text.slice(a, b))}</mark>`; at = b; }
  return out + esc(text.slice(at));
}

export function pickList(host: HTMLElement, o: { items: PickItem[]; value?: string; placeholder: string; onPick: (v: string) => void; empty?: string }): PickList {
  let value = o.items.some((x) => x.value === o.value) ? o.value! : "", active = 0, shown: PickItem[] = [];
  host.classList.add("pick-list");
  host.innerHTML = `<div class="pk-box">${icon("search")}<input type="text" autocomplete="off" spellcheck="false" placeholder="${esc(o.placeholder)}" role="combobox" aria-expanded="false">
      <button type="button" class="pk-clear" title="Clear" aria-label="Clear" hidden>${icon("x")}</button>${icon("chevronDown")}</div>
    <div class="pk-list" role="listbox" popover="manual"></div>`;
  const input = host.querySelector("input")!, list = host.querySelector<HTMLElement>(".pk-list")!, clear = host.querySelector<HTMLButtonElement>(".pk-clear")!;
  const box = host.querySelector<HTMLElement>(".pk-box")!;
  const picked = () => o.items.find((x) => x.value === value);
  /** The field shows what's picked (its heading too) when it's closed. */
  const label = (x?: PickItem) => (x ? `${x.group} · ${x.lead ? `${x.lead} ` : ""}${x.label}` : "");
  let opened = false;
  const isOpen = () => opened;
  /** The list is a popover (above a modal dialog, so a scrolling window can't cut it off), placed under the field, or
   *  above it when there's more room there, never taller than the room it has. */
  function place() {
    // (The field was drawn away, the window closed: so is the list.)
    if (!host.isConnected || !host.offsetParent) return close();
    const r = box.getBoundingClientRect(), gap = 10, below = innerHeight - r.bottom - gap, above = r.top - gap;
    const up = below < 220 && above > below, room = Math.max(120, Math.min(340, up ? above : below));
    host.classList.toggle("up", up);
    Object.assign(list.style, { left: `${r.left}px`, width: `${r.width}px`, maxHeight: `${room}px`, top: up ? "auto" : `${r.bottom}px`, bottom: up ? `${innerHeight - r.top}px` : "auto" });
  }
  const follow = (e: Event) => { if (!list.contains(e.target as Node)) place(); };

  function draw() {
    const words = fold(input.value.trim()).split(/\s+/).filter(Boolean);
    shown = o.items.filter((x) => { const hay = fold(`${x.label} ${x.group} ${x.lead || ""} ${x.words || ""}`); return words.every((w) => hay.includes(w)); });
    active = Math.min(Math.max(0, active), Math.max(0, shown.length - 1));
    let html = "", group: string | null = null;
    shown.forEach((x, i) => {
      if (x.group !== group) { group = x.group; html += `<div class="pk-group">${marked(x.group, words)}</div>`; }
      html += `<div class="pk-item${i === active ? " active" : ""}${x.value === value ? " picked" : ""}" role="option" data-i="${i}" aria-selected="${x.value === value}">
        ${x.lead ? `<span class="pk-lead">${esc(x.lead)}</span>` : ""}${x.icon ? icon(x.icon) : ""}<span class="pk-label">${marked(x.label, words)}</span>
        ${x.tag ? `<span class="pk-tag">${esc(x.tag)}</span>` : ""}${x.note ? `<span class="pk-note">${esc(x.note)}</span>` : ""}</div>`;
    });
    list.innerHTML = html || `<div class="pk-empty">${esc(o.empty || "Nothing found")}</div>`;
  }
  const scrollToActive = () => list.querySelector(".pk-item.active")?.scrollIntoView({ block: "nearest" });
  function open(keepText = false) {
    if (isOpen()) return;
    // Searching starts from nothing (unless they're already typing); what's picked is marked in the list.
    if (!keepText) input.value = "";
    active = Math.max(0, o.items.findIndex((x) => x.value === value));
    opened = true; input.setAttribute("aria-expanded", "true"); host.classList.add("open");
    draw(); place(); list.showPopover(); scrollToActive();
    // It follows the field when the window scrolls or the page resizes.
    addEventListener("scroll", follow, true); addEventListener("resize", place);
  }
  function close() {
    if (opened) { opened = false; try { list.hidePopover(); } catch { /* already gone */ } }
    removeEventListener("scroll", follow, true); removeEventListener("resize", place);
    input.setAttribute("aria-expanded", "false"); host.classList.remove("open");
    input.value = label(picked());
    clear.hidden = !value;
  }
  function pick(v: string) {
    value = v;
    close();
    o.onPick(v);
  }

  input.addEventListener("focus", () => open());
  input.addEventListener("click", () => open());
  input.addEventListener("input", () => { if (!isOpen()) open(true); active = 0; draw(); list.scrollTop = 0; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw(); scrollToActive();
    } else if (e.key === "Enter") {
      // (Not the form's submit.)
      if (isOpen()) { e.preventDefault(); if (shown[active]) pick(shown[active].value); }
    } else if (e.key === "Escape" && isOpen()) {
      // Closes the list, not the window around it.
      e.preventDefault(); e.stopPropagation(); close();
    } else if (e.key === "Tab" && isOpen()) close();
  });
  // A press in the list keeps the focus in the field (so it doesn't close before the click).
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => { const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]"); if (el) pick(shown[+el.dataset.i!].value); });
  list.addEventListener("mousemove", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (el && +el.dataset.i! !== active) { list.querySelector(".pk-item.active")?.classList.remove("active"); el.classList.add("active"); active = +el.dataset.i!; }
  });
  input.addEventListener("blur", () => { if (isOpen()) close(); });
  clear.addEventListener("mousedown", (e) => e.preventDefault());
  clear.addEventListener("click", () => { value = ""; input.value = ""; clear.hidden = true; o.onPick(""); input.focus(); });
  host.querySelector(".pk-box > svg:last-child")?.addEventListener("mousedown", (e) => { e.preventDefault(); if (isOpen()) close(); else { input.focus(); open(); } });
  close();
  return { value: () => value, set: (v) => { value = o.items.some((x) => x.value === v) ? v : ""; close(); } };
}
