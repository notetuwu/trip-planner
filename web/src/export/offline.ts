// "Download for phone": one self-contained HTML file (inline CSS, no server needed) built from the rendered itinerary.
// The map loads from the internet when there is a connection and is simply left out offline.
import { $, $$, downloadFile, esc } from "../core/dom";
import { dayColor, fmtDate } from "../core/format";
import { state } from "../core/state";
import { tripCountries } from "../geo/locate";
import { directionsUrl } from "../itinerary/directions";
import { APP_CSS } from "../styles";
import { OFFLINE_SCRIPT, offlineMapData } from "./offline-map";

const EXPORT_CSS = `
  main.offline { display: block; max-width: 760px; margin: 0 auto; padding: 12px 12px 40px; }
  .offline .panel { padding: 14px; }
  .daynav { position: sticky; top: 0; z-index: 1001; display: flex; gap: 6px; overflow-x: auto; padding: 8px 12px; background: var(--bg); border-bottom: 1px solid var(--line); }
  .daynav a { flex: none; font-size: 12px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink); background: var(--panel); text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
  .daynav a::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .daynav a.today { background: var(--accent); border-color: var(--accent); color: #fff; }
  .day { scroll-margin-top: 52px; }
  .day-head { cursor: default; }
  #map { height: 300px; border-radius: 14px; margin-bottom: 12px; border: 1px solid var(--line); }
  @media print { .daynav, #map { display: none; } }`;

export function offlineHtml() {
  const it = state.itinerary!;
  const content = $("#output").cloneNode(true) as HTMLElement;
  for (const el of $$(".toolbar, .refine, .bars, .error, .gen-meta, .del, .redo, .thoughts, .stale, .it-search", content)) el.remove();
  // Show everything, whatever the search box on the page is filtering.
  for (const el of $$(".day, .item, .fork, .city-band", content)) { el.hidden = false; el.classList.toggle("search-hit", false); }
  // The export has no script to fill directions links on click, so fill them in now.
  for (const a of $$<HTMLAnchorElement>("a[data-dir]", content)) {
    const [di, xi] = a.dataset.dir!.split("-").map(Number), url = directionsUrl(di, xi);
    if (url) a.href = url; else a.remove();
  }
  for (const el of $$(".day.selected", content)) el.classList.remove("selected");
  const title = it.destination || tripCountries().map(([, n]) => n).join(" & ") || "Trip";
  const nav = it.days.map((d, i) => `<a href="#day-${i}" data-date="${esc(d.date)}" style="--c:${dayColor(i)}">${esc(fmtDate(d.date) || d.date)}</a>`).join("");
  const data = JSON.stringify(offlineMapData()).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} itinerary</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script>document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";<\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"><\/script>
<style>
${APP_CSS}
${EXPORT_CSS}
</style>
</head>
<body>
<nav class="daynav">${nav}</nav>
<main class="offline"><div id="map" hidden></div><section class="panel">${content.innerHTML}</section></main>
<script>
  const DATA = ${data};
${OFFLINE_SCRIPT}
<\/script>
</body>
</html>`;
}

function phoneFile() {
  const base = (state.itinerary?.destination || state.stays.map((s) => s.city).filter(Boolean).join("-") || "trip").replace(/[^\p{L}\p{N}-]+/gu, "-");
  const name = base + "-itinerary.html";
  return new File([offlineHtml()], name, { type: "text/html" });
}

/** Saves the offline file (to send to your phone however you like). */
export function downloadForPhone() {
  const file = phoneFile();
  downloadFile(file, file.name);
}

/** Can this browser hand files to the system share sheet? (Then a separate Share button is shown.) */
export const canShareFiles = () => !!navigator.canShare?.({ files: [new File(["x"], "x.html", { type: "text/html" })] });

/** Opens the system share sheet with the offline file; falls back to saving it. */
export async function shareForPhone() {
  const file = phoneFile();
  try { await navigator.share({ files: [file], title: "Itinerary" }); }
  catch (e) { if ((e as Error).name !== "AbortError") downloadFile(file, file.name); }
}
