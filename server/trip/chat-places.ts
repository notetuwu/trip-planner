// The places the trip chat suggests are always map links. The model is told to write them that way, but smaller ones
// often don't: then the page's own reading of the reply links them, by name and the town being talked about.

/** What they ask about when the reply's names are places to go. */
const ABOUT_PLACES = /\b(restaurants?|caf[eé]s?|bars?|pubs?|eat(?:ing)?|food|lunch|dinner|breakfast|brunch|coffee|drinks?|baker(?:y|ies)|ramen|sushi|pizza|vegetarian|vegan|hotels?|hostels?|stay|shops?|stores?|markets?|places?|spots?|sights?|attractions?|museums?|temples?|shrines?|castles?|parks?|gardens?|onsen|viewpoints?|where)\b/i;

export const asksForPlaces = (text: string) => ABOUT_PLACES.test(text);

/** A bold or listed word that heads a part of the reply rather than naming a place. */
const NOT_A_PLACE = /^(day\b|morning|noon|midday|afternoon|evening|night|group\b|note|tip|why|price|cost|hours|address|getting there|option \d|vegetarian|vegan|lunch|dinner|breakfast|train|bus|car|taxi|walk|metro|tram|uber|flight|ferry|total|summary|my (pick|choice)|best\b|budget)|[:?!]$|^\d+([:.]\d+)?\s*(min|h|km|€|¥|\$|%)?$/i;

const LINKED = /\]\(\s*maps?:/;

/** The town a reply or a question is about: "in Soprabolzano", "near Asakusa"; else a town of the trip it names. */
export function townOf(texts: string[], towns: string[]): string {
  for (const text of texts) {
    const said = /\b(?:in|near|around)\s+\**(\p{Lu}[\p{L}'’-]+(?:[ -]\p{Lu}[\p{L}'’-]+){0,2})/u.exec(text)?.[1];
    if (said && !/^(Day|The|Your|This|That|Morning|Afternoon|Evening|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(said)) return said;
    const named = towns.find((t) => t && text.toLowerCase().includes(t.toLowerCase()));
    if (named) return named;
  }
  return "";
}

const link = (name: string, town: string) => {
  const query = name.replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
  return `[${name}](map:${query}${town && !query.toLowerCase().includes(town.toLowerCase()) ? `, ${town}` : ""})`;
};

/** The reply with the places it suggests linked: the bold name each line starts with, and the places offered to pick
 *  from (`offered`), where they aren't links already. */
export function linkSuggested(answer: string, offered: string[], town: string): string {
  const done = new Set<string>();
  let out = answer.split("\n").map((line) => {
    if (LINKED.test(line)) return line;
    return line.replace(/^(\s*(?:(?:[-*•]|\d+[.)]|#{1,6})\s+)?)\*\*([^*\n[\]]{2,60}?)\*\*/, (all, lead: string, name: string) => {
      const n = name.trim();
      if (NOT_A_PLACE.test(n)) return all;
      done.add(n.toLowerCase());
      return `${lead}**${link(n, town)}**`;
    });
  }).join("\n");
  for (const name of offered) {
    const n = name.trim();
    if (n.length < 3 || /[[\]]/.test(n) || NOT_A_PLACE.test(n) || done.has(n.toLowerCase()) || out.toLowerCase().includes(`[${n.toLowerCase()}`)) continue;
    // Its first mention that isn't part of a link already.
    const links = [...out.matchAll(/\[[^\]\n]*\]\(\s*maps?:(?:[^()\n]|\([^()\n]*\))+\)/g)].map((m) => [m.index, m.index + m[0].length]);
    const word = new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    const found = [...out.matchAll(word)].find((m) => !links.some(([a, b]) => m.index >= a && m.index < b));
    if (found) out = out.slice(0, found.index) + link(found[0], town) + out.slice(found.index! + found[0].length);
  }
  return out;
}

/** Words many places share, which don't say which one is meant. */
const GENERIC = /^(gasthaus|gasthof|restaurant|ristorante|trattoria|osteria|pizzeria|buschenschank|bistro|caf[eé]|hotel|museum|castle|temple|shrine|park|garden|market|house|the)$/i;
const wordsOf = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !GENERIC.test(w));

/** The answers to a question about which place, with every place the reply suggests (the ones its lines start with)
 *  among them: models list four and offer three. Only when two or more answers already name suggested places, so other
 *  questions stay as asked; the added ones go after the places, before answers like "keep it as it is". */
export function withEverySuggestion(options: string[], answer: string, most = 8): string[] {
  const suggested = [...new Set([...answer.matchAll(/^[ \t]*(?:(?:[-*•]|\d+[.)]|#{1,6})[ \t]+)?(?:\*\*)?\[([^\]\n]+)\]\(\s*maps?:/gm)].map((m) => m[1].replace(/\*/g, "").trim()))];
  const names = (option: string, place: string) => {
    const o = option.toLowerCase(), words = wordsOf(place);
    return o.includes(place.toLowerCase()) || words.some((w) => o.includes(w));
  };
  const places = options.map((o) => suggested.some((x) => names(o, x)));
  if (places.filter(Boolean).length < 2) return options;
  const missing = suggested.filter((x) => !options.some((o) => names(o, x))).slice(0, Math.max(0, most - options.length));
  const after = places.lastIndexOf(true) + 1;
  return [...options.slice(0, after), ...missing, ...options.slice(after)];
}
