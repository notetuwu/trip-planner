// What a stop's text says, for the checked planner's code steps (no page, no network): how names compare, which stops
// are transfers or rides, hotel stops, meals with or without a named place, and the place an activity's name is about.
import type { ItineraryItem } from "../../../shared/types";

export const lc = (s: unknown) => String(s ?? "").toLowerCase();
export const short = (city: string) => String(city || "").split(",")[0].trim();
/** A name for comparing: lower case, no accents, no brackets, no punctuation. */
export const norm = (s: unknown) => lc(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, " ").replace(/[^a-z0-9぀-ヿ一-鿿]+/g, " ").trim();
export const words = (s: unknown) => norm(s).split(" ").filter((w) => w.length >= 3);

// Words that name a kind of place, not the place ("cathedral", "bridge", "museum"), in the languages of the trips
// this app sees most: a hit must share a word beyond these (or all of these and the town, see sameName).
export const GENERIC_WORDS = new Set(("gasthaus gasthof restaurant ristorante trattoria osteria konoba cafe caffe coffee bakery hotel pension bar pub bistro park parc parco "
  + "street strasse street ulica via rue town walk trail tour old altstadt centre center city market markt mercato trznica house haus lunch dinner mount mountain monte mont berg "
  + "peak summit gipfel lake lago see jezero beach beaches plaza square platz piazza trg port porto harbour harbor hafen luka pier terminal station bahnhof museum muzej "
  + "museo musee gallery galerija galerie palace palazzo palais schloss castle burg dvorac grad cathedral kathedrale katedrala duomo dom basilica bazilika church kirche "
  + "chiesa crkva cerkev templom eglise bridge brucke bruecke ponte most pont tower turm torre toranj fort fortress festung tvrdava walls gate tor gardens garden garten "
  + "giardino vrt island isola otok abbey abbazia monastery kloster samostan theatre theater teatro opera library university hall rathaus fountain brunnen fontana viewpoint "
  + "lookout promenade riva quay national natural history art modern royal imperial").split(" "));

/** A stop names a place when most of the place's words are in it ("Chamonix old town and church" names "Chamonix,
 *  France"), at least one of them a real name ("Lake Balaton" doesn't name "Lake Bled" for the lake they share). */
export function names(stop: string, place: string) {
  const w = words(place.split(",")[0]), s = new Set(words(stop));
  if (!w.length) return false;
  const shared = w.filter((x) => s.has(x));
  return shared.length >= Math.max(1, Math.ceil(w.length / 2)) && (shared.some((x) => !GENERIC_WORDS.has(x)) || w.every((x) => GENERIC_WORDS.has(x)));
}

export const ARROW = /\s*(?:→|->|⇒|–>)\s*/;
/** "Split → Hvar (ferry)" → ["Split", "Hvar"]; null when the name isn't of that form. */
export function transferEnds(place: string): [string, string] | null {
  const ends = String(place || "").replace(/\s*\([^)]*\)\s*$/, "").split(ARROW).map((s) => s.trim()).filter(Boolean);
  return ends.length === 2 ? [ends[0], ends[1]] : null;
}
export const isTransfer = (x: Pick<ItineraryItem, "kind" | "place">) => x.kind === "transfer" || !!transferEnds(x.place);

/** Rides the map can't draw by itself (and the only transfers a plan should spell out). */
export const RIDE = /\b(ferry|ferries|boat|catamaran|ship|hydrofoil|cruise|train|rail|railway|cog|funicular|cable ?car|cableway|gondola|ropeway|chair ?lift|lift|flight|plane|bus|coach)\b/i;
/** A transfer that is a ride (by its mode in brackets, its name, or failing those its transport). */
export function isRide(x: Pick<ItineraryItem, "kind" | "place" | "transport">) {
  if (!isTransfer(x)) return false;
  const mode = /\(([^)]*)\)\s*$/.exec(x.place)?.[1] || "";
  if (mode) return RIDE.test(mode);
  return RIDE.test(x.place) || (!/\b(drive|driving|car|taxi|walk)\b/i.test(x.transport || "") && RIDE.test(x.transport || ""));
}
/** A transfer the map draws itself: a drive, a taxi, a walk. */
export const isDriveTransfer = (x: Pick<ItineraryItem, "kind" | "place" | "transport">) => isTransfer(x) && !isRide(x);

/** A transfer destination that is no place of its own ("→ Hotel", "Beach → Port", "Fort → Lunch"). */
export const GENERIC_DEST = /^(the\s+)?(port|old port|harbou?r|ferry terminal|terminal|pier|dock|station|bus station|train station|parking|car ?park|hotel|accommodation|lunch|dinner|breakfast|brunch|coffee|home|town|city|old town|city cent(re|er)|centre|center|beach|restaurant|café|cafe)$/i;
export const HOTEL_STOP = /^(hotel\b|(breakfast|dinner|rest|relax\w*|evening|night)\s+(at|in)\s+(the\s+|your\s+)?hotel|check[- ]?(in|out)\b|[\p{L}' -]{2,30}\s+hotel(\s*\(.*\))?$)|\b(at|back to|return to|rest at)\s+(the\s+|your\s+)?hotel\b|\bcheck[- ]?(in|out)\b/iu;
export const isCheckIn = (place: string) => /check[- ]?in\b/i.test(place) && !/check[- ]?out\b/i.test(place);
export const isCheckOut = (place: string) => /check[- ]?out\b/i.test(place);
export const isHotelStop = (x: Pick<ItineraryItem, "place">) => HOTEL_STOP.test(String(x.place));

export const MEAL_WORD = /^(?:[\p{L}]+(?:-friendly)?\s+)?(breakfast|brunch|lunch|dinner|supper|coffee|cake|snack|drinks|ap[ée]ro|aperitivo|ice cream|gelato)\b/iu;
/** A meal written as a kind of restaurant rather than a named one ("Vegetarian-friendly restaurant in Old Town", "Café in Old Town"). */
export const GENERIC_MEAL = /^(?:[\p{L}-]+\s+){0,2}(?:restaurant|ristorante|eatery|dining|café|cafe|coffee break|bistro|trattoria|konoba|gostilna)\s+(?:in|near|at|by|around|on)\b/iu;
export const isMealStop = (x: Pick<ItineraryItem, "kind" | "place">) => x.kind === "meal" || MEAL_WORD.test(x.place) || GENERIC_MEAL.test(x.place);
/** The restaurant a meal names ("Dinner: Konoba Riva", "Lunch at Gasthof Adler" → the name), "" for "Lunch near the castle" or "Dinner". */
export function namedMeal(place: string) {
  const p = String(place || "").replace(/\s*\([^)]*\)/g, "").trim();
  if (!MEAL_WORD.test(p)) return GENERIC_MEAL.test(p) ? "" : p;
  const m = /^(?:[\p{L}-]+\s+)?[^\s:@-]+(?:\s+(?:break|stop|time))?\s*(?::|-|–|@|\bat\b)\s*(?!the\b|a\b|an\b)(.+)$/iu.exec(p);
  return m && /^\p{Lu}/u.test(m[1].trim()) ? m[1].trim() : "";
}
/** Where a meal with no named place is ("Lunch near the Great Market Hall" → "the Great Market Hall"), "" when it says nothing. */
export function mealSpot(place: string) {
  const p = String(place || "").replace(/\s*\([^)]*\)/g, "").trim();
  if (!(MEAL_WORD.test(p) || GENERIC_MEAL.test(p)) || namedMeal(p)) return "";
  const m = /\b(?:near|by|around|close to|next to|opposite|in|on)\s+(?:the\s+)?(.+)$/i.exec(p);
  return m ? m[1].replace(/\s+(area|district|quarter|neighbou?rhood)$/i, "").trim() : "";
}

const ACTIVITY_START = /^(?:a\s+|an\s+)?(?:walk|stroll|wander|ramble|hike|explore|exploring|exploration of|visit|visiting|see|seeing|discover|tour of|free time|relax(?:ation)?|rest|evening|afternoon|morning|sunset|coffee|drinks|swim|swimming|beach time|shopping)\s+(?:through|around|along|in|at|of|on|to|by|the)?\s*(?:the\s+)?/i;
const ACTIVITY_END = /\s+(?:(?:old town|old city|town centre|town center|city centre|city center|harbou?r|waterfront|promenade)\s+)?(?:walk|walking tour|stroll|wander|tour|visit|exploration|loop|circuit|ramble|sightseeing|relaxation|time|break|session|experience)s?$/i;
/** The place an activity's name is about ("Walk along the Danube & Chain Bridge" → "Danube & Chain Bridge"), for looking it up. */
export function placeOf(name: string) {
  const clean = String(name || "").replace(/\s*\([^)]*\)/g, "").replace(/\s*[-–:]\s*(?:free|optional|relaxation|rest).*$/i, "").trim();
  const cut = clean.replace(ACTIVITY_START, "").replace(ACTIVITY_END, "").trim();
  return cut || clean;
}
/** The parts of a name that are places of their own ("Old Town Square & Plečnikova hiša"), the whole first. */
export function nameParts(name: string) {
  const whole = placeOf(name);
  const parts = whole.split(/\s*(?:&|\+|\/|,| and )\s*/i).map((s) => s.trim()).filter((s) => s.length >= 3);
  return [...new Set([whole, ...parts])];
}

/** Who does a stop: everyone ("") or a subgroup. */
export const doers = (x: ItineraryItem) => (x.who?.length ? x.who.join("+") : x.group || "");

export const minutes = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
export const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
export const hm = (m: number) => { const r = Math.round(m); return r >= 60 ? `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, "0")} min` : `${r} min`; };
