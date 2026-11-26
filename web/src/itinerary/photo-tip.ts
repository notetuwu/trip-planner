// The card beside the mouse over a picture in the photo gallery: its name, where it was taken, who took it, when, and
// the file's size. The place's name is looked up (OpenStreetMap) once the mouse has stayed on a picture for a moment, so
// running across the gallery asks for nothing.
import type { ReverseHit } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { fmtBytes } from "../core/format";
import { type Placed, folderOf, when } from "../map/photos";

/** How far from the pointer the card sits, and how long the mouse stays before the place is looked up. */
const GAP = 16, WAIT = 350;

/** Place names looked up so far, by position (to about 10 m); "" when there's none there. */
const places = new Map<string, string>();
const spotOf = (p: Placed) => `${p.lat!.toFixed(4)},${p.lng!.toFixed(4)}`;
const coords = (p: Placed) => `${p.lat!.toFixed(5)}, ${p.lng!.toFixed(5)}`;

/** Where it was taken, in words: the place's name once known, and how sure that is. */
export function placeText(p: Placed, name: string | undefined) {
  if (p.lat == null) return p.skipped ? "Marked “can't place”" : "Not known";
  const how = p.guessed ? `guessed from its time, near ${p.near}` : p.placed ? "placed by hand" : "";
  return [name === undefined ? "Looking up the place…" : name || coords(p), how ? `(${how})` : ""].filter(Boolean).join(" ");
}

/** The card's rows. "Taken by" is what the file says; Drive only knows who uploaded it. */
export function tipRows(p: Placed, name: string | undefined): [string, string][] {
  return [
    ["Location", placeText(p, name)],
    p.author ? ["Taken by", p.author] : p.by ? ["Uploaded by", p.by] : ["Taken by", "Not known"],
    p.t ? ["Taken", when(p.t)] : ["Taken", p.up ? `Not known (uploaded ${when(p.up)})` : "Not known"],
    ["File size", p.size ? fmtBytes(p.size) : "Not known"],
    ["Folder", folderOf(p)],
  ];
}

/** Shows the card over the pictures of `gallery` (those with `data-i`, their place in the list given to `set`). It
 *  lives in the window `host`, since a modal window covers everything outside it. */
export function photoTip(host: HTMLElement, gallery: HTMLElement) {
  const tip = document.createElement("div");
  tip.className = "ph-tip";
  tip.hidden = true;
  host.append(tip);
  let photos: Placed[] = [], shown: Placed | null = null, x = 0, y = 0, timer: number | undefined;

  /** Below and right of the pointer; on the other side where that would leave the screen. */
  const move = () => {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = x + GAP + w > innerWidth - 8 ? x - GAP - w : x + GAP;
    const top = y + GAP + h > innerHeight - 8 ? y - GAP - h : y + GAP;
    tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  };
  const draw = (p: Placed, name = p.lat == null ? undefined : places.get(spotOf(p))) => {
    tip.innerHTML = `<b>${esc(p.name)}</b><dl>${tipRows(p, name).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    move();
  };
  const lookUp = async (p: Placed) => {
    const key = spotOf(p);
    const hit = await api<Partial<ReverseHit>>(`/api/reverse?lat=${p.lat}&lng=${p.lng}`).catch(() => null);
    // A failed lookup isn't kept: it's asked again next time.
    const name = hit ? [...new Set([hit.options?.find((o) => o.level === "place")?.name, hit.short || hit.label].filter(Boolean))].join(", ") : "";
    if (hit) places.set(key, name);
    // (With no answer, the card gives the coordinates.)
    if (shown === p) draw(p, name);
  };
  const hide = () => { clearTimeout(timer); shown = null; tip.hidden = true; };

  gallery.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const at = e.target as HTMLElement;
    // Over a picture's buttons their own tooltips say what they do.
    const el = at.closest(".ph-pin, .ph-del") ? null : at.closest<HTMLElement>("[data-i]");
    const p = el ? photos[+el.dataset.i!] : undefined;
    if (!p) return hide();
    x = e.clientX; y = e.clientY;
    if (p === shown) return move();
    clearTimeout(timer);
    shown = p;
    tip.hidden = false;
    draw(p);
    if (p.lat != null && !places.has(spotOf(p))) timer = window.setTimeout(() => lookUp(p), WAIT);
  });
  gallery.addEventListener("pointerleave", hide);
  gallery.addEventListener("pointerdown", hide);
  gallery.addEventListener("scroll", hide, { passive: true });
  host.addEventListener("close", hide);

  return {
    /** The gallery was drawn again, with these photos. */
    set(list: Placed[]) { photos = list; hide(); },
  };
}
