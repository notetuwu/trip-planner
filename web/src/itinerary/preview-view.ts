// The trip preview: the trip in pictures. A collage of highlights with the route on top, then each stay and its days with
// a picture for each stop, and a slideshow of it all, from Wikimedia when that's switched on (server/geo/wiki-photos.ts).
// A preview of what's to come: their own photos (from the trip's photo folders) take the places of those they were taken
// at only when "Use my photos" is ticked.
import type { Day, PlacePicture } from "../../../shared/types";
import { api, closeOnBackdrop, esc, toast } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { type ViewItem, showGallery } from "../core/lightbox";
import { type AppPrefs, prefs, setPrefs } from "../core/prefs";
import { state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";
import { type Placed, allPhotos, folders, loadMissing, onPhotosChange, thumbTag, viewItem } from "../map/photos";
import { onMap } from "../map/travel-day";
import { cleanStop } from "../trip/modes";
import { highlights, ownPhotos } from "./preview-data";

interface Ask { id: string; name: string; city: string; cc: string; lat: number; lng: number }
interface Stop { key: string; name: string; must: boolean; ask: Ask | null; lat: number; lng: number }
interface DayPart { n: number; day: Day; stops: Stop[] }
interface Part { town: string; ask: Ask | null; days: DayPart[] }

/** One picture on the page and in the slideshow. */
interface Shot { src: string; small: string; item: ViewItem; town: string; must?: boolean; credit?: string }

/** Stops that are no place to have a picture of. */
const NO_PLACE = /^(breakfast\b|check[- ]?(in|out)|hotel\b|free time|rest\b|arriv|depart|return|back to|transfer)/i;
/** The own photos shown of one stop, and of a day away from its stops, in the slideshow. */
const PER_STOP = 4;

let dlg: HTMLDialogElement | null = null;
const OWN = "trip-planner-preview-own";
/** Their own photos replace the pictures of the places they were taken at (off: a preview of the trip). */
const useOwn = () => localStorage.getItem(OWN) === "1";
/** Wikimedia's answers this session, by what was asked. */
const found = new Map<string, PlacePicture | null>();
const askKey = (a: Ask) => `${a.name}|${a.lat.toFixed(3)},${a.lng.toFixed(3)}`;
let loading = false, trouble = "", progress = "", again = false;
/** The pictures on the page, in order (what a click opens). */
let shown: Shot[] = [];

/** The plan as the preview shows it: by stay (its town), then by day. */
function parts(): Part[] {
  const it = state.itinerary;
  if (!it) return [];
  const byTitle = byTitleMap(), out: Part[] = [];
  it.days.forEach((day, di) => {
    const stay = stayOn(day), sl = stay ? stayLoc(stay) : null;
    const town = (stay?.city || day.city || "").split(",")[0].trim();
    let part = out.at(-1);
    if (!part || part.town !== town) {
      part = { town, days: [], ask: sl && town ? { id: `town-${out.length}`, name: town, city: "", cc: sl.cc || "", lat: sl.lat, lng: sl.lng } : null };
      out.push(part);
    }
    const stops: Stop[] = [];
    day.items.forEach((x, xi) => {
      if (x.kind === "transfer" || !onMap(x, day)) return;
      const loc = itemLoc(x, day, byTitle), name = cleanStop(x.place);
      if (!loc || loc.elsewhere || NO_PLACE.test(name)) return;
      const key = `${di}-${xi}`;
      // A restaurant seldom has an article; one found by its name alone would likely be of something else.
      const ask = x.kind === "meal" ? null : { id: key, name: x.place, city: String(day.city).split(/\/|→|->|,/)[0].trim() || town, cc: sl?.cc || "", lat: loc.lat, lng: loc.lng };
      stops.push({ key, name, must: !!x.mustSee, ask, lat: loc.lat, lng: loc.lng });
    });
    part.days.push({ n: di + 1, day, stops });
  });
  return out;
}

/** Asks for the Wikimedia pictures not known yet, a few places at a time, showing them as they come. */
async function fetchPictures() {
  if (loading) { again = true; return; }
  if (!prefs.app.placePictures) return;
  const wanted = new Map<string, Ask>();
  for (const p of parts()) for (const a of [p.ask, ...p.days.flatMap((d) => d.stops.map((s) => s.ask))]) if (a && !found.has(askKey(a))) wanted.set(askKey(a), a);
  if (!wanted.size) return;
  loading = true; trouble = "";
  const going = () => !!dlg?.open && prefs.app.placePictures;
  /** Asks for them a group at a time; false when nothing can be asked just now. */
  const round = async (list: Ask[], size: number, quick: boolean) => {
    for (let i = 0; i < list.length && going(); i += size) {
      progress = `Finding pictures… ${[...wanted.keys()].filter((k) => found.has(k)).length} of ${wanted.size} places done`;
      render();
      const batch = list.slice(i, i + size);
      const r = await api<{ pictures: Record<string, PlacePicture | null>; failed: number }>("/api/place-pictures", { method: "POST", body: JSON.stringify({ quick, places: batch.map((a, k) => ({ ...a, id: String(k) })) }) });
      batch.forEach((a, k) => { if (String(k) in r.pictures) found.set(askKey(a), r.pictures[String(k)]); });
      if (r.failed) trouble = "Wikimedia didn't answer for some places (it limits how fast it can be asked). Open the preview again in a minute.";
      if (r.failed === batch.length) return false;
    }
    return true;
  };
  try {
    // First the places whose article has their name, many at once; then the others, searched for one by one.
    if (await round([...wanted.values()], 16, true)) await round([...wanted].filter(([k]) => !found.has(k)).map(([, a]) => a), 3, false);
  } catch (e) { trouble = `Couldn't get pictures: ${(e as Error).message}`; }
  loading = false;
  render();
  if (again) { again = false; fetchPictures(); }
}

const creditOf = (p: PlacePicture) => ["Photo", p.author && `: ${p.author}`, p.licence && `, ${p.licence}`, ", Wikimedia Commons"].filter(Boolean).join("");

function wikiShot(a: Ask | null, label: string, town: string, must = false): Shot | null {
  const p = a && found.get(askKey(a));
  if (!p || !prefs.app.placePictures) return null;
  const small = p.url.replace(/\/1280px-/, "/500px-"), credit = creditOf(p);
  return { src: p.url, small, town, must, credit, item: { src: p.url, thumb: small, caption: `${label} · ${credit}`, open: p.page, openLabel: "Picture's page" } };
}

const ownShot = (p: Placed, label: string, town: string, must = false): Shot => {
  const item = viewItem(p);
  return { src: item.src, small: item.thumb || item.src, town, must, item: { ...item, caption: `${label} · ${item.caption}` } };
};

interface Built { part: Part; cover: Shot | null; days: { d: DayPart; stops: { s: Stop; shots: Shot[]; own: Placed | null }[]; extra: { shot: Shot; photo: Placed }[] }[] }

/** Puts a picture to everything that has one. */
function build(): Built[] {
  const all = parts();
  const own = !useOwn() ? { byStop: new Map<string, Placed[]>(), extra: new Map<string, Placed[]>() } : ownPhotos(allPhotos(), all.flatMap((p) => p.days.map((d) => ({ date: d.day.date, stops: d.stops }))));
  return all.map((part) => {
    const days = part.days.map((d) => {
      const label = (name: string) => `Day ${d.n} · ${name}`;
      return {
        d,
        stops: d.stops.map((s) => {
          const mine = own.byStop.get(s.key) || [];
          const wiki = mine.length ? null : wikiShot(s.ask, label(s.name), part.town, s.must);
          return { s, own: mine[0] || null, shots: mine.length ? mine.map((p) => ownShot(p, label(s.name), part.town, s.must)) : wiki ? [wiki] : [] };
        }),
        extra: (own.extra.get(d.day.date) || []).map((photo) => ({ photo, shot: ownShot(photo, label(d.day.title || part.town), part.town) })),
      };
    });
    // Only what has a picture is shown: places, days and stays appear as theirs are found.
    const pictured = days.map((d) => ({ ...d, stops: d.stops.filter((x) => x.shots.length) })).filter((d) => d.stops.length || d.extra.length);
    const mine = pictured.flatMap((d) => [...d.stops.filter((x) => x.own).map((x) => x.shots[0]), ...d.extra.map((x) => x.shot)])[0];
    return { part, days: pictured, cover: mine || wikiShot(part.ask, part.town, part.town) };
  }).filter((b) => b.days.length);
}

const dates = () => {
  const d = state.itinerary?.days || [];
  return d.length ? `${fmtDate(d[0].date)} – ${fmtDate(d.at(-1)!.date)} · ${d.length} day${d.length === 1 ? "" : "s"}` : "";
};
/** The towns in order, all of them (also those with no picture yet). */
const routeOf = () => parts().map((p) => p.town).filter((t, i, a) => t && t !== a[i - 1]).join(" → ");
const title = () => state.saveName || state.itinerary?.destination || "Your trip";

/** The pictures of the collage: one per stop (their own where there is one). */
const collage = (built: Built[]) => highlights(built.flatMap((b) => b.days.flatMap((d) => d.stops.filter((x) => x.shots.length).map((x) => x.shots[0]))
  .concat(b.cover ? [b.cover] : [])), 5);

function slideshow(built: Built[]) {
  const route = routeOf();
  const first = collage(built)[0];
  const items: ViewItem[] = [{ src: first?.src || "", thumb: first?.small || "", caption: first?.credit || "", title: { head: title(), sub: [route, dates()].filter(Boolean).join(" · ") } }];
  for (const b of built) {
    const d = b.part.days;
    items.push({ src: b.cover?.src || "", thumb: b.cover?.small || "", caption: b.cover?.credit || "", title: { head: b.part.town, sub: d.length > 1 ? `${fmtDate(d[0].day.date)} – ${fmtDate(d.at(-1)!.day.date)}` : fmtDate(d[0].day.date) } });
    for (const day of b.days) {
      for (const s of day.stops) items.push(...s.shots.slice(0, PER_STOP).map((x) => x.item));
      items.push(...day.extra.slice(0, PER_STOP).map((x) => x.shot.item));
    }
  }
  if (!built.length) { toast("There are no pictures to show yet."); return; }
  showGallery(items, 0, { play: true });
}

/** A picture on the page, opening the viewer on it. */
function tile(shot: Shot, inner: string, label: string, cls: string, more = 0) {
  shown.push(shot);
  return `<button type="button" class="${cls}" data-shot="${shown.length - 1}" title="${esc(shot.credit || label)}">${inner}${shot.item.video ? `<i class="photo-play"></i>` : ""}${more ? `<b>+${more}</b>` : ""}<span>${esc(label)}</span></button>`;
}
const wikiImg = (s: Shot, big = false) => `<img src="${esc(big ? s.src : s.small)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;

function render() {
  if (!dlg?.open) return;
  const body = dlg.querySelector<HTMLElement>(".pv-body")!, built = build(), top = collage(built);
  const on = prefs.app.placePictures;
  const reading = useOwn() && folders().length && !allPhotos().length;
  dlg.querySelector<HTMLInputElement>("[data-pv-wiki]")!.checked = on;
  const ownBox = dlg.querySelector<HTMLInputElement>("[data-pv-own]")!;
  ownBox.checked = useOwn(); ownBox.parentElement!.hidden = !folders().length;
  dlg.querySelector<HTMLElement>("[data-pv-status]")!.textContent = loading ? progress : trouble || (reading ? "Reading your photo folders…" : "");
  shown = [];
  const route = routeOf();
  const offer = on ? "" : `<div class="pv-offer"><p><b>Pictures of the places are switched off.</b> With them on, the planner looks each stop up on Wikipedia (it sends the place's name and town) and shows a freely licensed picture where it finds one.${folders().length ? " Or tick “Use my photos” to see the trip in your own." : ""}</p>
      <button type="button" class="btn solid" data-pv-enable>Show pictures from Wikimedia</button></div>`;
  const credits = new Map(shown.map((s) => [s.src, s]));
  body.innerHTML = `
    <div class="pv-hero n${top.length}">
      ${top.map((s, i) => tile(s, wikiImg(s, i === 0), "", "pv-hi")).join("")}
      <div class="pv-title"><h3>${esc(title())}</h3><p>${esc(route)}</p><p>${esc(dates())}</p></div>
    </div>
    ${offer}
    ${!built.length && on && !loading && !reading ? `<p class="hint">No pictures were found for this trip's stops.</p>` : ""}
    ${built.map((b) => `<section class="pv-stay"><h4>${esc(b.part.town)}</h4>
      ${b.days.map((d) => {
        const cards = d.stops.map((x) => tile(x.shots[0], x.own ? thumbTag(x.own, 800, `loading="lazy"`) : wikiImg(x.shots[0]), x.s.name, `pv-card${x.own ? " own" : ""}`, x.shots.length - 1)
          // The rest of a stop's own photos are gone through from its first one.
          + (x.shots.slice(1).forEach((s) => shown.push(s)), ""));
        const extra = d.extra.slice(0, 8).map((x, i) => tile(x.shot, thumbTag(x.photo, 400, `loading="lazy"`), "", "pv-extra", i === 7 ? d.extra.length - 8 : 0));
        d.extra.slice(8).forEach((x) => shown.push(x.shot));
        return `<div class="pv-day"><h5>Day ${d.d.n} · ${esc(fmtDate(d.d.day.date))}${d.d.day.title ? ` <span>${esc(d.d.day.title)}</span>` : ""}</h5>
          ${cards.length ? `<div class="pv-grid">${cards.join("")}</div>` : ""}${extra.length ? `<div class="pv-extras">${extra.join("")}</div>` : ""}</div>`;
      }).join("")}</section>`).join("")}`;
  // Who took the Wikimedia pictures, as their licences ask.
  for (const s of shown) credits.set(s.src, s);
  const list = [...credits.values()].filter((s) => s.credit);
  if (list.length) body.insertAdjacentHTML("beforeend", `<details class="pv-credits"><summary>Picture credits (${list.length})</summary><ul>${list.map((s) => `<li><a href="${esc(s.item.open || "")}" target="_blank" rel="noopener">${esc(s.item.caption?.split(" · ").at(-2) || "")}</a> — ${esc(s.credit!)}</li>`).join("")}</ul></details>`);
  body.querySelectorAll<HTMLButtonElement>("[data-shot]").forEach((b) => { b.onclick = () => showGallery(shown.map((s) => s.item), +b.dataset.shot!); });
  body.querySelector<HTMLButtonElement>("[data-pv-enable]")?.addEventListener("click", () => setWiki(true));
}

/** Switches the Wikimedia pictures on or off (the same setting as in Settings → General). */
async function setWiki(on: boolean) {
  try {
    setPrefs(await api<{ app: AppPrefs }>("/api/settings", { method: "POST", body: JSON.stringify({ app: { placePictures: on } }) }));
  } catch (e) { toast(`Couldn't change it: ${(e as Error).message}`); }
  trouble = "";
  render();
  fetchPictures();
}

export function openPreview() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog preview-dialog";
    dlg.innerHTML = `<div class="pl-head"><h2>${icon("play")} Preview</h2><span class="hint" data-pv-status></span>
        <label class="ph-check" title="Your own photos (from the Photos window) instead of the pictures of the places they were taken at, and those of each day"><input type="checkbox" data-pv-own> Use my photos</label>
        <label class="ph-check" title="Look each stop up on Wikipedia and show a freely licensed picture of it where you have no photo of your own"><input type="checkbox" data-pv-wiki> Pictures from Wikimedia</label>
        <button type="button" class="btn solid" data-pv-play>${icon("play")} Play slideshow</button>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="pv-body"></div>`;
    document.body.append(dlg);
    closeOnBackdrop(dlg);
    dlg.querySelector<HTMLInputElement>("[data-pv-own]")!.onchange = (e) => {
      const yes = (e.target as HTMLInputElement).checked;
      localStorage.setItem(OWN, yes ? "1" : "");
      if (yes) loadMissing();
      render();
    };
    dlg.querySelector<HTMLInputElement>("[data-pv-wiki]")!.onchange = (e) => setWiki((e.target as HTMLInputElement).checked);
    dlg.querySelector<HTMLButtonElement>("[data-pv-play]")!.onclick = () => slideshow(build());
    // Their own photos take their places as the folders finish loading.
    onPhotosChange(render);
  }
  if (!dlg.open) dlg.showModal();
  trouble = "";
  if (useOwn()) loadMissing();
  render();
  dlg.querySelector<HTMLElement>(".pv-body")!.scrollTop = 0;
  fetchPictures();
}
