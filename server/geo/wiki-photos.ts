// A picture of a place from Wikipedia / Wikimedia Commons, for the trip preview (only when switched on in Settings or in
// the preview). The place is searched for by name; an article counts only when its title is the place's name and it lies
// where the stop is, so a stop never gets the picture of some other thing that happens to be near. Only freely licensed
// pictures, each with its author and licence. What's found (or not) is kept, so each place is asked about once.
// Wikimedia limits how often it can be asked, so most places are first looked up by their name as an article's title,
// many at once (the "quick" round); only the rest are searched for one by one.
import type { PlacePicture } from "../../shared/types";
import { USER_AGENT } from "../config";
import { diskCache } from "../util/disk-cache";

export interface PlaceAsked { id: string; name: string; city?: string; cc?: string; lat: number; lng: number }
export interface Article { title: string; lat?: number; lng?: number; file?: string; index: number }

const DAY = 864e5, KEEP = 90 * DAY, KEEP_NONE = 30 * DAY;
const cache = diskCache<{ at: number; pic: PlacePicture | null }>("place-pictures.json");

/** Words that say what kind of thing a place is, not which one. */
const GENERIC = new Set(("temple shrine castle park museum station market church cathedral garden gardens walk tour old town center centre city square "
  + "street bridge tower palace hall national the of de la le di del der die das am im and at to a an on in visit lunch dinner breakfast district area "
  + "view viewpoint observation deck beach lake mount river house shopping food morning evening night day").split(" "));

/** Lower case, accents off, everything else as single spaces. */
export const plain = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").toLowerCase().replace(/ß/g, "ss")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => plain(s).split(" ").filter(Boolean);

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

/** The names a stop could have an article under: without "(…)" and "Visit …", its first part, and what's in brackets. */
export function namesFor(name: string): string[] {
  const base = name.replace(/\s*\([^)]*\)/g, "").replace(/^(visit|explore|stroll( through| around)?|walk( through| around| in)?|(lunch|dinner|breakfast|brunch|coffee|drinks) (at|in))\s+/i, "").trim();
  const first = base.split(/\s+[–—-]\s+|\s*[:&+,]\s*|\s+and\s+/i)[0].trim();
  const inner = name.match(/\(([^)]+)\)/)?.[1]?.trim() || "";
  return [...new Set([base, first, /^[\p{Lu}\p{Lo}]/u.test(inner) && !/\d/.test(inner) && inner.length <= 40 ? inner : ""])].filter((n) => n.length >= 2).slice(0, 3);
}

/** How surely an article is about the place: 0 not, 1 (right there, a name in common), 2 (one name holds the other,
 *  close by), 3 (the same name). */
export function matchScore(name: string, city: string, article: Article, spot: { lat: number; lng: number }): number {
  const a = words(name), b = words(article.title.replace(/\s*\([^)]*\)/g, "").split(",")[0]);
  if (!a.length || !b.length) return 0;
  const far = article.lat == null || article.lng == null ? null : km(spot, { lat: article.lat, lng: article.lng });
  const joined = (w: string[]) => w.filter((x) => x !== "the").join("");
  if (joined(a) === joined(b)) return far == null || far <= 25 ? 3 : 0;
  if (far == null) return 0;
  const town = new Set(words(city));
  // What the two have in common that tells this place from others (not "temple", not the town's name).
  const shared = b.filter((w) => a.includes(w) && !GENERIC.has(w) && !town.has(w));
  if (!shared.length) return 0;
  if (far <= 5 && (b.every((w) => a.includes(w)) || a.every((w) => b.includes(w)))) return 2;
  return far <= 0.4 ? 1 : 0;
}

/** The countries whose own Wikipedia is asked when the English one has nothing. */
const LANGS: Record<string, string> = { de: "de", at: "de", ch: "de", it: "it", fr: "fr", es: "es", mx: "es", ar: "es", pt: "pt", br: "pt", jp: "ja", nl: "nl", pl: "pl", cz: "cs", se: "sv", no: "no", dk: "da", fi: "fi", gr: "el", hr: "hr", si: "sl", hu: "hu", kr: "ko", cn: "zh", tw: "zh", th: "th", vn: "vi", tr: "tr" };

/** Time between two requests (Wikimedia limits how many it takes a minute). */
const GAP = 350;
let turn = 0, pausedUntil = 0;

async function wiki(lang: string, params: Record<string, string>): Promise<any> {
  const now = Date.now();
  // Told to slow down: nothing more is asked until then.
  if (now < pausedUntil) throw new Error("Wikipedia asked to slow down");
  const at = Math.max(now, turn);
  turn = at + GAP;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`, {
    headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12000),
  });
  if (res.status === 429) pausedUntil = Date.now() + Math.min(600, Number(res.headers.get("retry-after")) || 60) * 1000;
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
  const got = await res.json() as any;
  // An error in a good answer is no "there's no picture": it's asked again another time.
  if (got.error) throw new Error(`Wikipedia: ${got.error.code}`);
  return got;
}

/** Drawings, maps, flags and logos say nothing about what a place looks like. */
const NOT_A_PHOTO = /\.(svg|gif|pdf|tiff?|ogv|webm)$|(^|[ _(-])(map|flag|logo|locator|plan|diagram)([ _.)-]|$)|coat[ _]of[ _]arms/i;

async function search(lang: string, q: string): Promise<Article[]> {
  const got = await wiki(lang, { generator: "search", gsrsearch: q, gsrlimit: "6", prop: "pageimages|coordinates", piprop: "name", pilimit: "max", colimit: "max" });
  return ((got.query?.pages || []) as any[]).map((p) => ({ title: String(p.title), index: Number(p.index) || 0, file: p.pageimage, lat: p.coordinates?.[0]?.lat, lng: p.coordinates?.[0]?.lon }));
}

const text = (html: unknown) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** A place with an article found for it, whose picture's address is still to be asked. */
interface Hit { p: PlaceAsked; lang: string; article: Article }

const townOf = (p: PlaceAsked) => (p.city || "").split(",")[0].trim();
/** The names to look a place up by. A part of a name that's only the town ("Lucerne – Alpnachstad boat") would give a
 *  picture of the town, so it's left out. */
function lookupNames(p: PlaceAsked) {
  const town = plain(townOf(p));
  return namesFor(p.name).filter((n) => !town || plain(n) !== town || plain(p.name) === town);
}
const languages = (p: PlaceAsked) => { const local = LANGS[(p.cc || "").toLowerCase()]; return local ? ["en", local] : ["en"]; };
const usable = (a: Article) => !!a.file && !NOT_A_PHOTO.test(a.file);

/** Many places at once: their names as article titles (Wikipedia follows other names of a place to its article). One
 *  request for up to 50 names. An article counts when it's near the stop. */
async function byTitle(lang: string, places: PlaceAsked[]): Promise<Hit[]> {
  const wanted = places.flatMap((p) => lookupNames(p).map((name) => ({ p, name: name.replace(/[|#<>[\]{}]/g, " ").trim() }))).filter((w) => w.name);
  const hits = new Map<string, Hit>();
  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    const got = await wiki(lang, { titles: [...new Set(chunk.map((w) => w.name))].join("|"), redirects: "1", prop: "pageimages|coordinates", piprop: "name", pilimit: "max", colimit: "max" });
    const to = (list: any[]) => new Map<string, string>((list || []).map((r) => [r.from, r.to]));
    const normal = to(got.query?.normalized), moved = to(got.query?.redirects);
    const pages = new Map<string, any>(((got.query?.pages || []) as any[]).map((x) => [x.title, x]));
    for (const w of chunk) {
      const named = normal.get(w.name) || w.name, page = pages.get(moved.get(named) || named);
      if (!page || page.missing || hits.has(w.p.id)) continue;
      const article: Article = { title: String(page.title), index: 0, file: page.pageimage, lat: page.coordinates?.[0]?.lat, lng: page.coordinates?.[0]?.lon };
      if (usable(article) && article.lat != null && article.lng != null && km(w.p, { lat: article.lat, lng: article.lng }) <= 25) hits.set(w.p.id, { p: w.p, lang, article });
    }
  }
  return [...hits.values()];
}

/** One place searched for, under each of its names, in English and the country's language. */
async function bySearch(p: PlaceAsked): Promise<Hit | null> {
  const town = townOf(p);
  for (const lang of languages(p)) {
    for (const name of lookupNames(p)) {
      const best = (await search(lang, town && !plain(name).includes(plain(town)) ? `${name} ${town}` : name))
        .filter(usable)
        .map((article) => ({ article, score: matchScore(name, town, article, p) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score || x.article.index - y.article.index)[0];
      if (best) return { p, lang, article: best.article };
    }
  }
  return null;
}

/** The pictures' addresses (at 1280 px wide), pages, authors and licences, many files at once; by the place's id. */
async function fileInfos(hits: Hit[]): Promise<Map<string, PlacePicture | null>> {
  const out = new Map<string, PlacePicture | null>();
  for (const lang of new Set(hits.map((h) => h.lang))) {
    const mine = hits.filter((h) => h.lang === lang);
    for (let i = 0; i < mine.length; i += 20) {
      const chunk = mine.slice(i, i + 20);
      const got = await wiki(lang, { titles: [...new Set(chunk.map((h) => `File:${h.article.file}`))].join("|"), prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1280", iiextmetadatafilter: "Artist|LicenseShortName" });
      const normal = new Map<string, string>((got.query?.normalized || []).map((r: any) => [r.from, r.to]));
      const pages = (got.query?.pages || []) as any[];
      for (const h of chunk) {
        const asked = `File:${h.article.file}`, name = normal.get(asked) || asked;
        const info = (pages.find((x) => x.title === name) || (chunk.length === 1 ? pages[0] : null))?.imageinfo?.[0];
        const meta = info?.extmetadata || {};
        out.set(h.p.id, !info?.thumburl || !/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(info.thumburl) ? null : {
          // (Without the tracking additions to the address.)
          url: String(info.thumburl).split("?")[0], page: String(info.descriptionurl || ""), title: h.article.title,
          author: text(meta.Artist?.value).slice(0, 80), licence: text(meta.LicenseShortName?.value).slice(0, 40),
        });
      }
    }
  }
  return out;
}

/** (The number goes up when what's kept can't be trusted any more, e.g. after a fault that kept "no picture".) */
const cacheKey = (p: PlaceAsked) => `2|${plain(p.name)}|${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;

/** The pictures of some places (null: there's none). Places not answered are left out: with `quick`, those that have
 *  to be searched for; otherwise those that couldn't be asked about, which are counted in `failed`. */
export async function placePictures(places: PlaceAsked[], quick = false): Promise<{ pictures: Record<string, PlacePicture | null>; failed: number }> {
  const pictures: Record<string, PlacePicture | null> = {};
  const keep = (p: PlaceAsked, pic: PlacePicture | null) => { cache.data[cacheKey(p)] = { at: Date.now(), pic }; cache.save(); pictures[p.id] = pic; };
  const rest = places.filter((p) => {
    const kept = cache.data[cacheKey(p)];
    if (!kept || Date.now() - kept.at >= (kept.pic ? KEEP : KEEP_NONE)) return true;
    pictures[p.id] = kept.pic;
    return false;
  });
  let failed = 0;
  const hits: Hit[] = [];
  try {
    if (quick) {
      // English first, then the countries' own languages for what's left.
      for (const lang of new Set(["en", ...rest.flatMap((p) => languages(p))])) {
        const ask = rest.filter((p) => languages(p).includes(lang) && !hits.some((h) => h.p === p));
        if (ask.length) hits.push(...await byTitle(lang, ask));
      }
    } else {
      for (const p of rest) {
        try { const hit = await bySearch(p); if (hit) hits.push(hit); else keep(p, null); }
        catch { failed++; } // offline or asked too fast: asked again next time
      }
    }
    const infos = await fileInfos(hits);
    for (const h of hits) keep(h.p, infos.get(h.p.id) ?? null);
  } catch { failed = places.length - Object.keys(pictures).length; }
  return { pictures, failed };
}
