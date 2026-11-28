// What the travelers wrote under interests, what they want to see and notes, read once by the model into something
// code can act on: the diets to look for in restaurants (OpenStreetMap tags them), allergies to tell the planner, the
// kinds of place they asked for (a lighthouse, thermal baths), and whether they'd rather have the famous sights or
// hidden gems. In any language: the model reads it, code only matches what it returns. Cached by the text, so a plan
// made again doesn't ask again; when no model can be asked, a few words in several languages are recognised instead.
import crypto from "node:crypto";
import { askModel } from "../ai/ask";
import { diskCache } from "../util/disk-cache";

/** Diets OpenStreetMap tags restaurants with ("diet:vegan"=yes|only). */
export const DIETS = ["vegetarian", "vegan", "pescetarian", "gluten_free", "lactose_free", "dairy_free", "halal", "kosher"] as const;
export type Diet = (typeof DIETS)[number];
export const DIET_LABEL: Record<Diet, string> = { vegetarian: "vegetarian", vegan: "vegan", pescetarian: "pescetarian", gluten_free: "gluten-free", lactose_free: "lactose-free", dairy_free: "dairy-free", halal: "halal", kosher: "kosher" };

/** Kinds of place they can ask for, with the OpenStreetMap filter that finds them. `rare`: few exist, so no Wikipedia
 *  article is needed to be worth listing, and they're looked for farther out. */
export const WANT_KINDS: Record<string, { label: string; filters: string[]; rare?: boolean }> = {
  lighthouse: { label: "lighthouse", filters: ['["man_made"="lighthouse"]'], rare: true },
  thermal_bath: { label: "thermal bath or spa", filters: ['["amenity"="public_bath"]', '["natural"="hot_spring"]', '["leisure"="spa"]'], rare: true },
  castle: { label: "castle or fortress", filters: ['["historic"~"^(castle|fort|citadel)$"]'] },
  palace: { label: "palace", filters: ['["historic"="palace"]', '["building"="palace"]'] },
  church: { label: "church or cathedral", filters: ['["amenity"="place_of_worship"]["religion"="christian"]["wikipedia"]'] },
  temple: { label: "temple, shrine, mosque or synagogue", filters: ['["amenity"="place_of_worship"]["religion"!="christian"]["wikipedia"]'] },
  monastery: { label: "monastery or abbey", filters: ['["amenity"="monastery"]', '["historic"="monastery"]'] },
  museum: { label: "museum", filters: ['["tourism"="museum"]["wikipedia"]'] },
  art: { label: "art gallery or street art", filters: ['["tourism"="gallery"]', '["tourism"="artwork"]["wikipedia"]'] },
  ruins: { label: "ruins or archaeological site", filters: ['["historic"~"^(ruins|archaeological_site)$"]'] },
  viewpoint: { label: "viewpoint", filters: ['["tourism"="viewpoint"]'] },
  tower: { label: "observation tower", filters: ['["man_made"="tower"]["tower:type"="observation"]'], rare: true },
  bridge: { label: "bridge", filters: ['["man_made"="bridge"]["wikipedia"]', '["bridge"="yes"]["wikipedia"]'] },
  waterfall: { label: "waterfall", filters: ['["waterway"="waterfall"]'], rare: true },
  cave: { label: "cave", filters: ['["natural"="cave_entrance"]'], rare: true },
  beach: { label: "beach", filters: ['["natural"="beach"]'] },
  lake: { label: "lake", filters: ['["natural"="water"]["water"="lake"]["wikipedia"]'], rare: true },
  mountain: { label: "mountain or peak", filters: ['["natural"="peak"]["wikipedia"]'], rare: true },
  nature: { label: "national park or nature reserve", filters: ['["boundary"="national_park"]', '["leisure"="nature_reserve"]["wikipedia"]'], rare: true },
  park: { label: "park or garden", filters: ['["leisure"~"^(park|garden)$"]["wikipedia"]'] },
  botanical: { label: "botanical garden", filters: ['["leisure"="garden"]["garden:type"="botanical"]'], rare: true },
  zoo: { label: "zoo or aquarium", filters: ['["tourism"~"^(zoo|aquarium)$"]'], rare: true },
  theme_park: { label: "theme park", filters: ['["tourism"="theme_park"]'], rare: true },
  market: { label: "market", filters: ['["amenity"="marketplace"]'] },
  winery: { label: "winery or vineyard", filters: ['["craft"="winery"]', '["landuse"="vineyard"]["wikipedia"]'], rare: true },
  brewery: { label: "brewery or distillery", filters: ['["craft"~"^(brewery|distillery)$"]', '["microbrewery"="yes"]'], rare: true },
  coffee_house: { label: "historic café or coffee house", filters: ['["amenity"="cafe"]["wikipedia"]'] },
  theatre: { label: "theatre, opera or concert hall", filters: ['["amenity"="theatre"]["wikipedia"]'] },
  windmill: { label: "windmill", filters: ['["man_made"="windmill"]'], rare: true },
  aqueduct: { label: "aqueduct", filters: ['["historic"="aqueduct"]', '["bridge"="aqueduct"]'], rare: true },
  memorial: { label: "memorial or monument", filters: ['["historic"~"^(memorial|monument)$"]["wikipedia"]'] },
  cemetery: { label: "historic cemetery", filters: ['["landuse"="cemetery"]["wikipedia"]', '["amenity"="grave_yard"]["wikipedia"]'] },
  stadium: { label: "stadium", filters: ['["leisure"="stadium"]["wikipedia"]'], rare: true },
  library: { label: "library", filters: ['["amenity"="library"]["wikipedia"]'] },
  observatory: { label: "observatory or planetarium", filters: ['["man_made"="observatory"]', '["amenity"="planetarium"]'], rare: true },
  harbour: { label: "harbour or marina", filters: ['["leisure"="marina"]', '["harbour"="yes"]["name"]'] },
  mine: { label: "mine or salt mine", filters: ['["historic"="mine"]', '["tourism"="attraction"]["man_made"~"^(mine|mineshaft|adit)$"]'], rare: true },
};
export type WantKind = keyof typeof WANT_KINDS;

export interface Want { kind: WantKind; what: string; where?: string }
export interface Prefs {
  /** The diets they need restaurants for. */
  diet: Diet[];
  /** Allergies and intolerances, in their words. */
  allergies: string[];
  /** What they'd rather not have, in their words ("crowds", "museums"). */
  avoid: string[];
  /** Kinds of place they asked to see. */
  wants: Want[];
  /** Famous sights or hidden gems, when their text says so. */
  placeMix?: "popular" | "mixed" | "hidden";
}
export const NO_PREFS: Prefs = { diet: [], allergies: [], avoid: [], wants: [] };

const PREFS_SCHEMA = {
  name: "preferences",
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      diet: { type: "array", items: { type: "string", enum: [...DIETS] } },
      allergies: { type: "array", items: { type: "string" } },
      avoid: { type: "array", items: { type: "string" } },
      wants: { type: "array", items: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: Object.keys(WANT_KINDS) }, what: { type: "string" }, where: { type: ["string", "null"] } }, required: ["kind", "what", "where"] } },
      placeMix: { type: ["string", "null"], enum: ["popular", "mixed", "hidden", null] },
    },
    required: ["diet", "allergies", "avoid", "wants", "placeMix"],
  },
};

export function prefsPrompt(text: string) {
  return `Travelers wrote the notes below for their trip planner, in whatever language. Read them and answer with JSON only (English keys and values), nothing else:
- "diet": the diets a restaurant must cater for, from: ${DIETS.join(", ")}. Only when they say so (a wish to eat well isn't a diet).
- "allergies": food allergies and intolerances in a few words each ("nuts", "shellfish"); [] if none.
- "avoid": what they'd rather not have, a few words each ("crowds", "long hikes", "museums"); [] if none.
- "wants": kinds of place they explicitly ask to see or do, one entry each, "kind" from: ${Object.keys(WANT_KINDS).join(", ")}; "what" their own words; "where" the town or region they mean, or null for anywhere. Only kinds they actually ask for: a description of a town ("imperial palaces and coffee houses") counts, a general wish ("cool things", "the trip of a lifetime") doesn't. Nothing that isn't in the list.
- "placeMix": "popular" if they want the famous sights, "hidden" if they want lesser-known places and local favourites instead, "mixed" if they ask for both; null if they don't say.

Notes:
"""
${text.trim()}
"""`;
}

/** The words recognised without a model (several languages): a fallback, not the way. */
const DIET_WORDS: Record<Diet, RegExp> = {
  vegan: /\bveg[aá]n\w*|végétalien|\bvegaani/i,
  vegetarian: /\bveg(etari|gi)\w*|végétarien|vegetarisch|vegetariano|vegetarisk|wegetaria|素食|ベジタリアン/i,
  pescetarian: /pesc[ea]tari\w*/i,
  gluten_free: /gluten|glutine|glúten|senza glutine|sans gluten|グルテン/i,
  lactose_free: /lactos|laktos|lattosio|乳糖/i,
  dairy_free: /dairy[- ]?free|milchfrei|sans produits laitiers|senza latticini/i,
  halal: /\bhalal\b|حلال/i,
  kosher: /\bkosher|koscher|casher|cachère|כשר/i,
};

/** What the words alone give away (no model asked). */
export function prefsFromWords(text: string): Prefs {
  const diet = DIETS.filter((d) => DIET_WORDS[d].test(text));
  const mix = /hidden gem|off the beaten|lesser[- ]known|geheimtipp|insider|local favou?rite|non touristi/i.test(text) && /popular|famous|must[- ]see|highlight|classic|sehenswürdigkeit|top sight/i.test(text) ? "mixed"
    : /hidden gem|off the beaten|lesser[- ]known|geheimtipp|insider|local favou?rite|non touristi/i.test(text) ? "hidden"
    : /only (the )?(popular|famous|main|big) |just the (famous|big|main|highlights)/i.test(text) ? "popular" : undefined;
  return { ...NO_PREFS, diet, ...(mix ? { placeMix: mix } : {}) };
}

/** Only what the schema allows, whatever came back. */
export function cleanPrefs(raw: unknown): Prefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 60)).slice(0, max) : []);
  const diet = [...new Set(strs(o.diet, 8).filter((d): d is Diet => (DIETS as readonly string[]).includes(d)))];
  const wants: Want[] = (Array.isArray(o.wants) ? o.wants : []).filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .map((w) => ({ kind: String(w.kind) as WantKind, what: String(w.what ?? "").trim().slice(0, 80), ...(typeof w.where === "string" && w.where.trim() ? { where: w.where.trim().slice(0, 60) } : {}) }))
    .filter((w) => w.kind in WANT_KINDS && w.what).slice(0, 12);
  const mix = ["popular", "mixed", "hidden"].includes(String(o.placeMix)) ? (o.placeMix as Prefs["placeMix"]) : undefined;
  return { diet, allergies: strs(o.allergies, 8), avoid: strs(o.avoid, 8), wants, ...(mix ? { placeMix: mix } : {}) };
}

const cache = diskCache<{ at: number; prefs: Prefs }>("prefs.json");
const keyOf = (text: string) => crypto.createHash("sha1").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 16);

/**
 * The travelers' preferences from their interests, wishes and notes: by the model when one is given (cached by the
 * text), else from the words. Never throws: a model that can't be reached leaves the words' reading.
 */
export async function readPrefs(trip: { interests?: string; wishes?: string; notes?: string; model?: string }, ask = askModel, signal?: AbortSignal, store: Pick<typeof cache, "data" | "save"> = cache): Promise<Prefs> {
  const text = [trip.interests, trip.wishes, trip.notes].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
  if (!text) return NO_PREFS;
  const words = prefsFromWords(text);
  if (!trip.model) return words;
  const key = keyOf(text), hit = store.data[key];
  if (hit) return hit.prefs;
  try {
    const reply = await ask(String(trip.model), prefsPrompt(text), () => {}, { schema: PREFS_SCHEMA, maxTokens: 2000, timeoutMs: 3 * 60_000, signal });
    const prefs = cleanPrefs(JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)));
    // What the words say for sure stays (a model that missed "vegan" doesn't lose it).
    prefs.diet = [...new Set([...prefs.diet, ...words.diet])];
    if (!prefs.placeMix && words.placeMix) prefs.placeMix = words.placeMix;
    store.data[key] = { at: Date.now(), prefs };
    store.save();
    return prefs;
  } catch (e) {
    if (signal?.aborted) throw e;
    console.error("Reading the travelers' preferences failed:", e instanceof Error ? e.message : e);
    return words;
  }
}

/** The preferences as prompt lines for the planner (what code can't enforce: allergies, things to avoid). */
export function prefsLines(prefs: Prefs | undefined) {
  if (!prefs) return "";
  const lines: string[] = [];
  if (prefs.diet.length) lines.push(`- Food: every restaurant must suit a ${prefs.diet.map((d) => DIET_LABEL[d]).join(" and ")} diet (the lists mark the ones known to); say in the description what to order or ask for.`);
  if (prefs.allergies.length) lines.push(`- Allergies: ${prefs.allergies.join(", ")}. Mention in each meal's description to tell the kitchen, and avoid places built around those foods.`);
  if (prefs.avoid.length) lines.push(`- They'd rather not: ${prefs.avoid.join(", ")}.`);
  if (prefs.wants.length) lines.push(`- They asked to see: ${prefs.wants.map((w) => `${w.what}${w.where ? ` (${w.where})` : ""}`).join("; ")}. Each gets at least one stop in the trip where a real one is within reach of a stay (candidates are listed per town); say in the notes if one couldn't be fitted.`);
  return lines.join("\n");
}

/** Which places a trip gets: its own setting, else what the wishes said, else a mix. */
export const placeMixOf = (trip: { placeMix?: string; prefs?: Prefs }): "popular" | "mixed" | "hidden" =>
  trip.placeMix === "popular" || trip.placeMix === "hidden" || trip.placeMix === "mixed" ? trip.placeMix : trip.prefs?.placeMix || "mixed";
