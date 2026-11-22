// A picture big, over everything: scroll to zoom (towards the pointer), drag to move it when zoomed, double-click to
// zoom in or back out; a click outside it or Escape closes it. "Search with Google" copies it and opens Google Images,
// where it's pasted into the search by image (Google refuses uploads that don't come from its own pages, so it can't be
// handed over directly).
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

export function showPicture(src: string) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<div class="lightbox-stage"><img src="${esc(src)}" alt="" draggable="false"></div>
    <button type="button" class="lightbox-x" title="Close (Esc)">${icon("x")}</button>
    <div class="lightbox-bar"><button type="button" class="btn solid" data-lens>${icon("search")} Search with Google</button>
      <span class="hint" data-hint>Scroll to zoom · drag to move</span></div>`;
  const img = box.querySelector("img")!, hint = box.querySelector<HTMLElement>("[data-hint]")!;

  // Zoom and pan: the picture is scaled around the pointer and moved by dragging.
  let scale = 1, x = 0, y = 0, dragged = false;
  const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; img.classList.toggle("zoomed", scale > 1); };
  const zoomAt = (cx: number, cy: number, next: number) => {
    next = Math.min(8, Math.max(1, next));
    const r = img.getBoundingClientRect();
    // Keep the point under the pointer where it is.
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    x -= px * (next / scale - 1); y -= py * (next / scale - 1);
    scale = next;
    if (scale === 1) { x = 0; y = 0; }
    apply();
  };
  box.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
  img.addEventListener("dblclick", (e) => { e.stopPropagation(); zoomAt(e.clientX, e.clientY, scale > 1 ? 1 : 2.5); });
  img.addEventListener("pointerdown", (e) => {
    if (scale === 1) return;
    e.preventDefault();
    dragged = false;
    const sx = e.clientX - x, sy = e.clientY - y;
    img.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => { dragged = true; x = m.clientX - sx; y = m.clientY - sy; apply(); };
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerup", () => img.removeEventListener("pointermove", move), { once: true });
  });

  const close = () => { box.classList.remove("show"); setTimeout(() => box.remove(), 180); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  box.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".lightbox-bar")) return;
    if (t === img) { if (!dragged && scale === 1) close(); dragged = false; return; } // a click on the picture closes it unless zoomed
    close();
  };
  box.querySelector<HTMLButtonElement>("[data-lens]")!.onclick = async () => {
    const copied = await copyPicture(img).then(() => true, () => false);
    if (!copied) {
      // No clipboard (e.g. on a phone over the home network): save the picture to upload it there instead.
      const a = document.createElement("a");
      a.href = src; a.download = "place.jpg"; a.click();
    }
    window.open("https://images.google.com/", "_blank", "noopener");
    hint.textContent = copied ? "Copied. In Google Images, click the camera icon, then paste it (Ctrl+V)." : "Saved the picture. In Google Images, click the camera icon and upload it.";
  };
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  requestAnimationFrame(() => box.classList.add("show"));
}
