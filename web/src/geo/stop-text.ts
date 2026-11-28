// What a stop's name says about it, without looking anything up: an activity in a town the name gives ("Kempten old
// town walk"), or a meal with no particular place ("Lunch in Vaduz"). No imports, so the tests can use it too.

// "Kempten old town walk", "Gaflei hamlet walk", "Walk through Lindau": an activity in a town that the name gives.
const ACTIVITY_END = /\s+(?:(?:old town|old city|altstadt|historic centre|historic center|town centre|town center|city centre|city center|centre|center|hamlet|village|town|city|harbour|harbor|lakefront|waterfront|promenade)\s+)?(?:walk|walking tour|stroll|wander|tour|visit|exploration|loop|circuit|ramble|sightseeing|evening|afternoon|morning)s?$/i;
const ACTIVITY_START = /^(?:walk|stroll|wander|ramble|evening|afternoon|morning|free time|explore|exploring|wander|sightseeing)\s+(?:through|around|in|along|of|at)?\s*(?:the\s+)?(?:old town of\s+|old city of\s+|centre of\s+|center of\s+)?/i;
/** The town an activity's name is about ("Kempten old town walk" → "Kempten"), or "" when the name is a place itself. */
export function activityTown(name: string) {
  const clean = String(name).replace(/\s*\([^)]*\)/g, "").trim();
  const cut = clean.replace(ACTIVITY_END, "").replace(ACTIVITY_START, "").replace(/^(lunch|dinner|breakfast|brunch|coffee|drinks)\s+(in|at)\s+/i, "").trim();
  return cut && cut !== clean && /^\p{Lu}/u.test(cut) && cut.split(/\s+/).length <= 3 ? cut : "";
}

/** A transfer destination that is no place of its own ("Beach → Port", "Fort → Lunch"): looked up by name it would
 *  land anywhere in the world (a "Port" in another country). */
export const genericDestination = (s: string) => /^(the )?(port|harbou?r|ferry terminal|terminal|pier|station|parking|car ?park|hotel|accommodation|lunch|dinner|breakfast|brunch|coffee|home|town|city|old town|city cent(re|er)|centre|center)$/i.test(String(s).trim());

/** A "where" that says no more than the town ("Lyon, France", "Genoa", "Near the museum"): it pins every stop
 *  with it on the town's middle, over the place the stop's own name would find. */
export function vagueWhere(where: string, towns: string[]) {
  const first = String(where).split(",")[0].trim().toLowerCase();
  if (!first || /^(near|around|hotel\b|your hotel|city cent(re|er))\b/.test(first)) return true;
  return towns.map((t) => t.split(",")[0].trim().toLowerCase()).some((t) => !!t && (t === first || t.startsWith(`${first} `)));
}

/** "Lunch", "Dinner around the Marktplatz", "Coffee break": a meal with no particular place, for which the maps app
 *  should list what's there rather than route to a name it can't find. */
const MEAL = /^(breakfast|brunch|lunch|dinner|supper|coffee|cake|snack|drinks|apéro|aperitivo|ice cream|gelato)\b/i;
export function genericMeal(name: string) {
  const n = String(name).replace(/\s*\([^)]*\)/g, "").trim();
  if (!MEAL.test(n)) return null;
  // "Lunch at Gasthof Adler" names a place; "Lunch in Vaduz", "Lunch around the old town", "Dinner" don't.
  if (/^\S+\s+(at|:|-)\s+\S/i.test(n)) return null;
  const what = /^(coffee|cake)/i.test(n) ? "cafés" : /^(drinks|apéro|aperitivo)/i.test(n) ? "bars" : /^(ice cream|gelato)/i.test(n) ? "ice cream" : "restaurants";
  const where = n.replace(MEAL, "").replace(/^\s*(break|stop|time)?\s*(in|around|near|by|at|on)?\s*(the\s+)?/i, "").trim();
  return { what, where };
}
