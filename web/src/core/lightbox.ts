// A picture big, over everything: scroll to zoom (towards the pointer), drag to move it when zoomed, double-click to
// zoom in or back out; a click outside it or Escape closes it. Several pictures (the photos of a group on the map) can
// be gone through with arrows or the keys, with a strip of them all along the bottom; each shows at once at a size the
// screen needs, and the original file replaces it as soon as that has loaded. "Search with Google" (for the chat's
// pictures) copies it and opens Google Images, where it's pasted into the search by image (Google refuses uploads that
// don't come from its own pages, so it can't be handed over directly).
import { esc } from "./dom";
import { icon } from "./icons";

/** Copies the picture (as PNG, what the clipboard takes) so it can be pasted into Google's search by image. */
async function copyPicture(img: HTMLImageElement) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  const png = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("no picture"))), "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** One picture of a set: what to show at once, the original to swap in when it has loaded, its small version for the
 *  strip, and a line of text. */
export interface ViewItem {
  src: string; full?: string; thumb?: string; caption?: string;
  /** A video: played from this address (`src` is a frame from it, shown until it plays); `open`: where else to watch it. */
  video?: string; open?: string;
  /** Where Google's own player shows the video, for when the browser can't play the file itself. */
  embed?: string;
  /** How far to turn the small picture in the strip (a preview stored unrotated), in degrees. */
  turn?: number;
  /** What the link to `open` says (otherwise Google Drive). */
  openLabel?: string;
  /** A title card of a slideshow: big words over the picture (which may be none: `src` ""). */
  title?: { head: string; sub: string };
}

/** A picture on its own, with "Search with Google". */
export function showPicture(src: string) { open([{ src }], 0, true); }

/** How long the slideshow stays on a picture, and on a title card (milliseconds). */
const SLIDE = 4500, CARD = 3500;

/** Pictures to go through (arrows, keys, the strip along the bottom), starting at `index`. */
export function showGallery(items: ViewItem[], index = 0, opts: { play?: boolean } = {}) { open(items, index, false, !!opts.play); }

function open(items: ViewItem[], start: number, search: boolean, play = false) {
  const many = items.length > 1;
  const box = document.createElement("div");
  box.className = `lightbox${many ? " gallery" : ""}`;
  box.innerHTML = `<div class="lightbox-stage"><img alt="" draggable="false" referrerpolicy="no-referrer"><video controls playsinline preload="metadata" hidden></video><iframe class="lightbox-embed" allow="autoplay; fullscreen" allowfullscreen hidden></iframe></div>
    <div class="lightbox-title" hidden><h2></h2><p></p></div>
    <button type="button" class="lightbox-x" title="Close (Esc)">${icon("x")}</button>
    ${many ? `<button type="button" class="lightbox-nav prev" title="Previous (←)">${icon("chevronDown")}</button><button type="button" class="lightbox-nav next" title="Next (→)">${icon("chevronDown")}</button>` : ""}
    <div class="lightbox-bar"><a class="btn" data-open target="_blank" rel="noopener" hidden>Open in Google Drive</a>${search ? `<button type="button" class="btn solid" data-lens>${icon("search")} Search with Google</button>` : ""}
      ${many ? `<button type="button" class="btn" data-play></button>` : ""}
      ${many || !search ? `<span class="lightbox-count" data-count></span>` : ""}<span class="hint" data-hint></span></div>
    ${many ? `<div class="lightbox-strip">${items.map((it, i) => `<button type="button" data-i="${i}"${it.video ? ' class="vid"' : ""}><img src="${esc(it.thumb || it.src)}" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer"${it.turn ? ` style="transform:rotate(${it.turn}deg)"` : ""}></button>`).join("")}</div>` : ""}`;
  const img = box.querySelector<HTMLImageElement>(".lightbox-stage img")!, hint = box.querySelector<HTMLElement>("[data-hint]")!;
  const vid = box.querySelector<HTMLVideoElement>("video")!, frame = box.querySelector<HTMLIFrameElement>(".lightbox-embed")!, openLink = box.querySelector<HTMLAnchorElement>("[data-open]")!;
  /** How to zoom, in words: for a mouse (fingers pinch and drag without being told). */
  const mouseHint = (text: string) => (matchMedia("(pointer: coarse)").matches ? "" : text);
  if (search) hint.textContent = mouseHint("Scroll to zoom · drag to move");
  const count = box.querySelector<HTMLElement>("[data-count]"), strip = box.querySelector<HTMLElement>(".lightbox-strip");

  // Zoom and pan: the picture is scaled around the pointer and moved by dragging.
  let scale = 1, x = 0, y = 0, dragged = false;
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; img.classList.toggle("zoomed", scale > 1); };
  const reset = () => { scale = 1; x = 0; y = 0; apply(); };

  // The slideshow: each picture stays a while (drifting closer), a video until it ends; it stops at the last one, and
  // when a picture is zoomed into.
  let playing = play && many, timer: number | undefined;
  const title = box.querySelector<HTMLElement>(".lightbox-title")!, playBtn = box.querySelector<HTMLButtonElement>("[data-play]");
  const playLabel = () => { if (playBtn) playBtn.innerHTML = playing ? `${icon("pause")} Pause` : `${icon("play")} Play`; };
  const advance = () => { if (cur < items.length - 1) go(cur + 1); else setPlaying(false); };
  /** Starts the time of the picture on screen (once it's there). */
  const wait = () => {
    clearTimeout(timer);
    img.classList.remove("drift");
    const it = items[cur];
    if (!playing || !it) return;
    if (it.video) { if (!vid.hidden) { vid.play().catch(() => { timer = window.setTimeout(advance, SLIDE); }); } else timer = window.setTimeout(advance, SLIDE * 2); return; }
    const ms = it.title ? CARD : SLIDE;
    // (Reading the width restarts the drift for this picture.)
    void img.offsetWidth;
    img.style.setProperty("--drift", `${ms + 600}ms`);
    img.classList.add("drift");
    timer = window.setTimeout(advance, ms);
  };
  const setPlaying = (yes: boolean) => {
    // Pressed on the last picture: from the beginning.
    if (yes && cur === items.length - 1) { playing = true; playLabel(); go(0); return; }
    playing = yes; playLabel();
    if (!yes) { clearTimeout(timer); img.classList.remove("drift"); } else wait();
  };
  playBtn?.addEventListener("click", () => setPlaying(!playing));
  playLabel();
  vid.addEventListener("ended", () => { if (playing) advance(); });
  img.addEventListener("load", () => { if (items[cur] && img.getAttribute("src") === items[cur].src) wait(); });
  img.addEventListener("error", () => { if (playing) { clearTimeout(timer); timer = window.setTimeout(advance, 600); } });
  const zoomAt = (cx: number, cy: number, next: number) => {
    next = Math.min(8, Math.max(1, next));
    if (next > 1 && playing) setPlaying(false);
    const r = img.getBoundingClientRect();
    // Keep the point under the pointer where it is.
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    x -= px * (next / scale - 1); y -= py * (next / scale - 1);
    scale = next;
    if (scale === 1) { x = 0; y = 0; }
    apply();
  };
  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    // Over the strip along the bottom, the wheel goes through it sideways.
    const row = (e.target as Element).closest?.(".lightbox-strip");
    if (row) { row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; return; }
    zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
  img.addEventListener("dblclick", (e) => { e.stopPropagation(); zoomAt(e.clientX, e.clientY, scale > 1 ? 1 : 2.5); });
  img.addEventListener("pointerdown", (e) => {
    if (scale === 1 || e.pointerType === "touch") return; // fingers: below
    e.preventDefault();
    dragged = false;
    const sx = e.clientX - x, sy = e.clientY - y;
    img.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => { dragged = true; x = m.clientX - sx; y = m.clientY - sy; apply(); };
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerup", () => img.removeEventListener("pointermove", move), { once: true });
  });

  // Fingers: two pinch to zoom, one moves a zoomed picture, and a swipe sideways goes to the next or the one before.
  const stage = box.querySelector<HTMLElement>(".lightbox-stage")!;
  const fingers = new Map<number, PointerEvent>();
  let swipe: { x: number; y: number } | null = null;
  /** The fingers' middle, and how far apart two of them are. */
  const hold = () => { const [a, b = a] = [...fingers.values()]; return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, gap: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }; };
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || (e.target as Element).closest("video, iframe")) return;
    fingers.set(e.pointerId, e);
    stage.setPointerCapture(e.pointerId);
    swipe = fingers.size === 1 && scale === 1 && many ? { x: e.clientX, y: e.clientY } : null;
    if (fingers.size === 1) dragged = false;
  });
  stage.addEventListener("pointermove", (e) => {
    if (!fingers.has(e.pointerId)) return;
    const was = hold();
    fingers.set(e.pointerId, e);
    const now = hold();
    if (swipe) {
      const dx = e.clientX - swipe.x;
      if (Math.abs(dx) > 8) { dragged = true; img.style.transform = `translate(${dx}px, 0)`; }
      return;
    }
    if (fingers.size > 1 && was.gap) zoomAt(now.x, now.y, scale * (now.gap / was.gap));
    if (scale > 1) { dragged = true; x += now.x - was.x; y += now.y - was.y; apply(); }
  });
  const lift = (e: PointerEvent) => {
    if (!fingers.delete(e.pointerId) || !swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    apply();
    if (e.type === "pointerup" && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { dragged = true; go(cur + (dx < 0 ? 1 : -1)); }
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);
  // A tap on the picture doesn't close it with fingers (the cross does, or a tap beside it): swipes and double taps start there.
  let touched = false;
  box.addEventListener("pointerdown", (e) => { touched = e.pointerType === "touch"; dragged = false; }, true);

  // Which picture is shown. Its original loads in the background and replaces it when ready (unless they've moved on).
  let cur = -1;
  const go = (i: number) => {
    i = ((i % items.length) + items.length) % items.length;
    if (i === cur) return;
    cur = i;
    const it = items[i];
    reset();
    clearTimeout(timer);
    img.classList.remove("drift");
    title.hidden = !it.title;
    box.classList.toggle("card", !!it.title);
    if (it.title) { title.querySelector("h2")!.textContent = it.title.head; title.querySelector("p")!.textContent = it.title.sub; }
    // A video plays in its own player (with a frame from it until it starts); a picture is zoomed and moved.
    vid.pause();
    frame.hidden = true; frame.removeAttribute("src");
    img.hidden = !!it.video || !it.src; vid.hidden = !it.video;
    openLink.hidden = !it.open;
    if (it.open) { openLink.href = it.open; openLink.textContent = it.openLabel || "Open in Google Drive"; }
    if (it.video) { vid.poster = it.src; vid.src = it.video; hint.textContent = "Video"; }
    else {
      vid.removeAttribute("src"); vid.load();
      // The same picture as before (a title card's, then the stop's own) loads no second time: its time starts now.
      const same = img.getAttribute("src") === it.src;
      if (it.src) img.src = it.src; else img.removeAttribute("src");
      if (!it.src || (same && img.complete)) wait();
    }
    if (count) count.textContent = [many ? `${i + 1} / ${items.length}` : "", it.caption].filter(Boolean).join(" · ");
    if (strip) {
      strip.querySelectorAll<HTMLElement>("button.on").forEach((b) => b.classList.remove("on"));
      const b = strip.querySelector<HTMLElement>(`button[data-i="${i}"]`);
      b?.classList.add("on");
      b?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
    if (!it.video && it.full && it.full !== it.src) {
      hint.textContent = "Loading the original…";
      const big = new Image();
      big.referrerPolicy = "no-referrer";
      big.onload = () => { if (cur === i) { img.src = it.full!; hint.textContent = mouseHint("Original · scroll to zoom, drag to move"); } };
      // Not every original can be shown (a phone's HEIC, say): the picture already on screen stays.
      big.onerror = () => { if (cur === i) hint.textContent = mouseHint("Scroll to zoom · drag to move"); };
      big.src = it.full;
    } else if (!search && !it.video) hint.textContent = it.title ? "" : mouseHint("Scroll to zoom · drag to move");
    if (it.video) wait();
  };
  strip?.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-i]"); if (b) go(+b.dataset.i!); });
  box.querySelector(".lightbox-nav.prev")?.addEventListener("click", () => go(cur - 1));
  box.querySelector(".lightbox-nav.next")?.addEventListener("click", () => go(cur + 1));

  // Not every video can be played in a browser (a phone's HEVC, say): it says so and points to Drive.
  // For a Drive video, Google's own player is shown instead (it converts any format it knows).
  vid.onerror = () => {
    if (!vid.getAttribute("src")) return;
    const it = items[cur];
    if (playing) { clearTimeout(timer); timer = window.setTimeout(advance, SLIDE * 2); }
    if (it?.embed) { vid.hidden = true; frame.hidden = false; frame.src = it.embed; hint.textContent = "This browser can't play the file itself: shown through Google Drive."; }
    else { hint.textContent = it?.open ? "This browser can't play this video. Open it in Google Drive." : "This browser can't play this video (phones' HEVC often can't)."; openLink.hidden = !it?.open; }
  };
  const close = () => { playing = false; clearTimeout(timer); vid.pause(); box.classList.remove("show"); setTimeout(() => box.remove(), 180); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => {
    // The player's own arrow keys seek in the video.
    if (e.target instanceof HTMLVideoElement && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    // (Escape closes the viewer only, not the window it's open over.)
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (many && e.key === " " && !(e.target instanceof HTMLVideoElement)) { e.preventDefault(); setPlaying(!playing); }
    else if (many && e.key === "ArrowLeft") go(cur - 1);
    else if (many && e.key === "ArrowRight") go(cur + 1);
  };
  box.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".lightbox-x")) return close();
    if (t.closest(".lightbox-bar, .lightbox-strip, .lightbox-nav, video, iframe")) return;
    // (With the finger captured by the stage, a tap on the picture arrives as one on the stage: told apart by place.)
    if (touched) {
      const r = img.getBoundingClientRect(), on = !img.hidden && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!on && !dragged && scale === 1) close();
      dragged = false;
      return;
    }
    if (t === img) { if (!dragged && scale === 1) close(); dragged = false; return; } // a click on the picture closes it unless zoomed
    close();
  };
  box.querySelector<HTMLButtonElement>("[data-lens]")?.addEventListener("click", async () => {
    const copied = await copyPicture(img).then(() => true, () => false);
    if (!copied) {
      // No clipboard (e.g. on a phone over the home network): save the picture to upload it there instead.
      const a = document.createElement("a");
      a.href = items[cur].src; a.download = "place.jpg"; a.click();
    }
    window.open("https://images.google.com/", "_blank", "noopener");
    hint.textContent = copied ? "Copied. In Google Images, click the camera icon, then paste it (Ctrl+V)." : "Saved the picture. In Google Images, click the camera icon and upload it.";
  });
  document.addEventListener("keydown", onKey);
  // Over an open window too (a modal window is above everything else on the page, even a fixed layer in the body).
  (document.querySelector<HTMLElement>("dialog[open]") || document.body).append(box);
  go(Math.max(0, Math.min(items.length - 1, start)));
  requestAnimationFrame(() => box.classList.add("show"));
}
