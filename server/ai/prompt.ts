// The planning prompt. Sections with data come from prompt-sections.ts; this file holds the instructions.
import { tune } from "../settings";
import type { Place } from "../../shared/types";
import { bookingsSection, trainsSection, holidayLines, hasChosenModes, nearbySection, placeLines, requestsSection, stayLines } from "./prompt-sections";
import { LOCAL_SCHEMA } from "./schema";
import type { Trip } from "./types";

/** How many stops a day should have at each pace (meals come on top). */
const STOPS_PER_DAY = { relaxed: "3-4", balanced: "4-6", packed: "6-8" };

export interface PromptOptions {
  /** Shorter lists of nearby places (local models: a smaller prompt is faster to read and leaves room to think). */
  compact?: boolean;
  /** "text": planning notes as plain text before the itinerary; "json": in a planningNotes field (JSON-only answers). */
  notes?: "text" | "json";
  /** The model can search the web itself while planning (used when the trip asks for research). */
  webTools?: boolean;
  /** The itinerary goes into this tool call instead of a structured answer. */
  outputTool?: string;
  /** Append the JSON schema, for servers that may not enforce it. */
  schema?: boolean;
}

/** How much walking and climbing the plan can ask of them. */
const FITNESS = {
  easy: "easy: little walking and no real hikes; short, flat walks only (up to about 1 hour), with lifts, cable cars or the car for anything steep",
  average: "average: walks of a few hours are fine; hikes up to about 3 hours or 500 m of climbing",
  fit: "fit: long hikes (5+ hours, 1000 m of climbing) are fine",
} as const;
const BREAKFAST = {
  hotel: "at the hotel (no breakfast stop in the plan; the first stop is after it)",
  out: "out, at a café or bakery near where they are (a named stop each morning)",
  brunch: "a late brunch instead of breakfast and lunch (a named brunch place around 10:30-11:30, then no separate lunch)",
  skip: "they skip it (no breakfast stop at all)",
} as const;

/** When the days start, breakfast and fitness, as constraint lines. */
function dayShapeLines(trip: Trip) {
  const lines = [`- Fitness: ${FITNESS[trip.fitness || "average"] || FITNESS.average}`];
  if (/^\d{2}:\d{2}$/.test(trip.dayStart || "")) lines.push(`- Days start around ${trip.dayStart}: the first stop (or breakfast) is at about that time. Start earlier only when the day needs it (a day trip, a travel day with a long drive, a booked early time, a place that's only quiet or open early, a packed day with several big sights) and then say why in the day's notes; on a normal day in town, don't.`);
  if (trip.breakfast && BREAKFAST[trip.breakfast]) lines.push(`- Breakfast: ${BREAKFAST[trip.breakfast]}.`);
  return lines.join("\n");
}

/** What a stop's description says, by the detail chosen in Settings → Planning. */
const DETAIL = {
  brief: "one short sentence on what it is and why go, plus anything they must know (book ahead, closed days).",
  normal: "what to do there and why it's worth it, with practical details (opening hours, whether to book ahead, best time to go, what to order).",
  detailed: "a few sentences: what to see and do there and why it's worth it, the highlights not to miss, practical details (opening hours, whether to book ahead, best time to go, how long to allow, what to order), and a local tip.",
} as const;

export function buildPrompt(trip: Trip, places: Place[], opts: PromptOptions = {}) {
  const t = tune();
  const json = opts.notes === "json";
  const research = !!opts.webTools && !!trip.research;
  const holidays = holidayLines(trip);
  const nearby = nearbySection(trip, opts.compact);
  const pace = (Object.keys(STOPS_PER_DAY) as (keyof typeof STOPS_PER_DAY)[]).find((k) => String(trip.pace).startsWith(k)) || "balanced";
  const giveBack = opts.outputTool
    ? ` Then call the \`${opts.outputTool}\` tool with the complete itinerary (never write the itinerary itself as text).`
    : " Then return the itinerary.";

  let prompt = `You are an expert local travel planner building a detailed, realistic day-by-day itinerary. Work out the destination country or countries from the stays and the saved places.

${research
  ? `Research online while you plan, using web search and web fetch: opening hours and closing days on the actual dates, current ticket prices, festivals and events during the trip, transport options, times and prices between the cities, and anything else that is date-dependent or uncertain. Prefer official websites. Focus on the must-sees, day trips and transfers rather than looking up every café; up to about ${t.lookups} searches. Where you could not verify something, say so in the item's description.`
  : `Use your own knowledge of the destination (geography, opening days, holidays, transit, typical prices, local customs).${!json && !opts.outputTool ? " Do not use tools; just answer." : ""}`}

${json
  ? `If you think before answering, keep it brief (a few short paragraphs): most of your effort belongs in the itinerary itself. Answer with one JSON object only, matching the schema${opts.schema ? " at the end" : ""}. Start with "planningNotes": notes for the travelers`
  : `${research ? "When your research is done, and right before" : "Before"} returning the itinerary, write your planning notes as plain text in your reply (not inside the itinerary; its "summary" is just a 2-4 sentence overview) for the travelers`} (they can expand them to see how you approached the plan): how you split the days between cities and day trips, where the must-sees went and why, what the holidays and events mean for the plan, budget trade-offs, and anything you had to compromise on or leave out. Use short paragraphs or "- " bullets (one bullet per line), under 250 words.${json ? "" : giveBack}

## Stays (in order)
${stayLines(trip)}
${requestsSection(trip) ? `
${requestsSection(trip)}
` : ""}${bookingsSection(trip) ? `
${bookingsSection(trip)}
` : ""}${trainsSection(trip) ? `
${trainsSection(trip)}
` : ""}
## Constraints
- Daily budget: ${trip.budgetPer === "person" && trip.travelers > 1 ? `${trip.dailyBudget} ${trip.currency} per person per day, so ${trip.dailyBudget * trip.travelers} ${trip.currency} a day for the group of ${trip.travelers}` : `${trip.dailyBudget} ${trip.currency} per day for ${trip.travelers} traveler(s)`} (costs in the plan are for the whole group), covering activities, food and local transport (accommodation is already paid, intercity transfers count toward the day they happen). It is a ceiling, not a target.
- Pace: ${trip.pace}
${dayShapeLines(trip)}
- Interests / preferences: ${trip.interests || "none given"}${trip.wishes?.trim() ? `
- What they want to see: ${trip.wishes.trim()}` : ""}
- Their own requests: see above.
${trip.researchNotes ? `
## Web research findings (gathered online just now; trust these over your own memory)
${trip.researchNotes}
` : ""}${holidays ? `
## Public holidays during the trip (official list from date.nager.at)
Plan around these: closed shops and museums, changed transit timetables, crowds, and celebrations worth seeing. Regional holidays only apply in the listed states/cantons.
${holidays}
` : ""}
## Saved places
${places.length ? `The travelers' own ideas: places they saved because they want to go there. Build the itinerary primarily from these: use as many as fit the route, the days and their interests well, group them by area into themed days, and prefer them over places from the lists below or your own ideas. Only [MUST SEE] places are required; leave out the ones that don't fit well (too far off the route, or no day they suit). Places marked [MUST SEE] must be included. Never schedule [SKIP] places. Hotels in the list are accommodation candidates, not activities. Day trips from a base city are fine if reasonable. Add meals and a few unlisted highlights to fill the days; set fromList=false for those.
Places marked "[MUST SEE for N of M travelers]" only interest part of the group. You may split the group up for those: the N go there while the others do something else (ideally another place only they want, so split places pair up). Batch split places into as few split sessions as is sensible and bring everyone back together afterwards. While split, give every item a "group" label (e.g. "Group A", "Group B") and "people" count, and list each subgroup's items in time order; items done together have no group. You can also skip splitting and take everyone if that is clearly simpler.
${placeLines(trip, places)}` : "No saved places; choose the best things to do yourself (fromList=false)."}
${nearby ? `
## Real places around each stay (from OpenStreetMap)
These exist, with exact locations. Use them for sights and especially for meals, writing the name exactly as listed and copying its location into "lat"/"lng". Sights are within about 8 km, food within about 2.5 km of where you sleep. Each list belongs to its stay: only use a place on days spent at that stay (or passing right by it), never on a day in another city, even if the name sounds generic.
${nearby}
` : ""}
## What every day must look like
- Choosing sights: mix the essential highlights of each place (the ones most visitors would be sorry to miss) with a few lesser-known spots that fit their interests, the kind locals recommend${trip.wishes?.trim() ? `, weighted the way they describe under "What they want to see"` : ""}. Give each full day a theme or an area.
- Only real places: every named stop must exist under exactly that name (from the saved places, the lists above, or your research). Never make up names for restaurants, cafés or sights. If you don't know a real place for a meal, write a generic stop such as "Lunch around the Marktplatz" instead of inventing one.
- ${STOPS_PER_DAY[pace]} sights or activities per full day, plus meals: a specific, named place for lunch and for dinner (and breakfast when not at the hotel) that fits the interests and dietary needs, and a different one each time (no restaurant or café twice in the trip unless they ask). Arrival and departure days can be lighter, but still plan the hours that are free.
- One lunch and one dinner a day, never two of either. A restaurant they ask for on a day (in their requests or bookings) is that day's lunch or dinner at that time: don't add another meal next to it (no second dinner at 19:00 after McDonald's at 17:00); a restaurant you had in mind instead goes on another day.
- Hikes and long climbs (an hour or more on foot, or a steep climb such as up a mountain) are the main event of their day: plan them in the morning while fresh, with only easy things afterwards (a meal, a café, a relaxed stroll, a spa), or as the last activity of the day. Never schedule another big sight (a castle, a large museum, a theme park) after one. Fit hikes to their fitness above.
- Before giving a stop its time, check when it opens and closes on that weekday: many museums and castles open at 9:00 or 10:00, cafés at 7:00-9:00, and restaurants often close between lunch and dinner. Don't plan breakfast before the café opens.
- Never write "MUST SEE" (or "[MUST SEE]") into a stop's name or description: the page marks must-sees itself.
- "time": the start time in 24-hour "HH:MM" only, nothing else. Items in chronological order with realistic durations, travel time between them and opening hours respected.
- "transport": how to get there from the previous stop, with mode or line and minutes, e.g. "Tram 1 from Hauptbahnhof, 12 min" or "Walk, 5 min".
- "cost": on every item, for the whole group (0 if free): tickets, meals, fares. The day's "estimatedCost" is the sum of its item costs. Don't pad days to reach the budget.
- "description": ${DETAIL[t.detail]}
- "kind" on every item: sight, activity, meal, transfer or other. A scenic ride that is an attraction in itself (a cog railway or cable car up a mountain, a boat tour) is an activity, not a transfer.
- "booking" on everything that costs money to get in (museums, castles, tours, cable cars, timed entry, table reservations), even when you simply pay at the door; omit it only for free places: "essential" when it sells out or needs a timed slot, "recommended" when booking online saves queueing or money, "optional" when tickets are easy to get on the spot. With essential or recommended, "bookAhead" says how far ahead, e.g. "2-3 weeks before" or "the day before". For paid places, "website" is the official ticket page or website (e.g. the operator's own site, not a reseller), only when you know it for certain${research ? " or found it online" : ""}; leave it out rather than guess.
- Where a place lists its opening hours ("hours …", OpenStreetMap syntax), schedule it while it's open on that weekday.
- Daylight: the stays above give sunrise and sunset. Places you go to see outdoors (shrines and temples, gardens, viewpoints, lakes, old streets, hikes, scenic rides) must be done in daylight, finished by about 30 minutes before sunset; in autumn and winter that means starting them early. After dark, plan only what works then: dinners, indoor sights, evening streets, night views and illuminations (say so when a place is lit up at night).
- "notes" on the day: anything that affects it, such as holidays, closures (e.g. museums closed on Mondays), markets, festivals, weather and season, bookings to make ahead, or the day going over budget.
- On travel days between cities, the transfer is its own item with departure time, duration, operator or route and price. Name it "<from> → <to> (<mode>)", e.g. "Padua → Milan (car)". Plan around check-out (about 10:00) and check-in (about 15:00).${hasChosenModes(trip) ? `
- Where the stays above say how the travelers get somewhere ("chosen by the travelers"), use exactly that mode; don't swap it for another. By car: the route and main roads, driving time, distance, tolls or vignettes, fuel and parking costs, and a worthwhile stop on the way if there is one. By train or bus: a real connection with operator, departure time, duration and fare, and whether to book ahead. Day trips with a chosen mode are their own outbound and return items ("Milan → Rome (train)", later "Rome → Milan (train)").` : ""}
- Road distances and driving times given with the stays come from a routing service: trust them over your own idea of geography or borders. If a drive is longer than one travel day allows, don't pretend it fits: say so plainly in the planning notes and plan that day around the drive (and suggest how to make it work, e.g. extra nights on the way).
- A planned day trip that "only N of the M travelers" take is a split day: those N go on the trip while the others spend the day elsewhere (another such day trip, if the stay has one that the rest of the group takes, on the same day; otherwise a day of their own near the stay). Use the "group" and "people" fields on every item while they're apart (writing "Group A" only in the description isn't enough: the fields are what splits the day into columns and map lines), give each group its own meals, and bring them back together in the evening if that's sensible. Day trips the travelers set up here are part of the plan: never drop one for being far away.
- Getting between towns (a day trip there and back, or a stop on the way) is one transfer item each way, named "<from> → <to> (<mode>)", e.g. "Osaka → Himeji (JR Special Rapid)"; its "transport" says which station to walk or ride to, and the next stop's "transport" how to get on from the station there ("Walk 15 min up Otemae-dori from JR Himeji"). Stations, platforms and the hotel are never stops of their own (no "Osaka Station" or "Hotel" item), except checking in or out. By car, the first stop's transport says where to park.
- A place on the way between two stays (a mountain pass, a lake, a castle) is a stop on the drive itself: route the drive through it on the road it lies on (over the pass, through its valley; e.g. Bolzano → Sarntal → Penser Joch → Sterzing → Brenner → Innsbruck rather than the A22 motorway), with the stops in driving order. Never drive past it on the motorway, go up to it and come back the same way to carry on. The transfer item's "transport" names that road.
- Day trips and other long excursions (anything more than about 30-45 minutes away from where you sleep) go on full days only, never on a travel day: changing cities and doing a day trip on the same day is exhausting. Travel days get the transfer plus light sightseeing near the hotel or a stop on the way that lies directly on the route. For example, with 2 nights in Padua the one full day there is the day for Venice. If a must-see day trip fits no full day, say so in the notes (or list it in "unused") rather than squeezing it into a travel day.

## Trip-wide extras
- "holidaysAndEvents": every public holiday, festival, major event or seasonal highlight in the visited places during the trip, with what it means for the plan.
- "tips": 6-10 specific, practical tips for this trip: money and payment, transport passes or tickets worth buying (with prices; for things bought online, such as a motorway vignette, a toll account or a rail pass, end the tip with the official website to buy it, only when you know it for certain${research ? " or found it online" : ""}), reservations to make and how far ahead, etiquette, SIM/data, luggage, tipping.
- "unused": saved places you could not fit, with a short reason: every must-see you left out, and the saved places (from their lists) near the stays that you chose not to use (up to about 25 of the most notable, e.g. "too far from the route", "closed on the days there", "similar to X, which is in the plan").${research ? `
- "sources": the URLs you relied on most.` : ""}

## Output rules
- "city" on each day: the town(s) it happens in; on day trips and split days name every town visited, e.g. "Osaka / Onomichi / Hiroshima".
- "destination": the country or countries of the trip. "localCurrency": the local currency's ISO code.${t.language ? `
- Write all text for the travelers (planning notes, summary, titles, descriptions, notes, tips, events) in ${t.language}. Keep the names of places as they are known locally (and exactly as listed above for saved places); the JSON keys stay in English.` : ""}
- One entry in "days" for every calendar day from the first arrival to the final departure day, with dates in YYYY-MM-DD.
- "place" is only the place's name. For items from the list it must be the exact Title as written above, without the details in brackets or braces.
- Give every item "lat"/"lng" coordinates (4 decimals) so it can be shown on a map.
- All costs in ${trip.currency}.
- Group nearby places on the same day to minimise transit: sights within about 2 km of each other (a castle and an aquarium in the same part of town, two waterfalls in the same valley) go on the same day, one after the other, and never send them back on another day to a place right next to one they already visited.
- If the group splits for part of a day (including splits mentioned in the notes), use "group"/"people" on those items as described above.`;

  if (trip.revise?.itinerary && trip.revise?.request) {
    prompt += `

## Current itinerary
${JSON.stringify(trip.revise.itinerary)}

## Requested changes
${trip.revise.request}

Apply the requested changes to the current itinerary and return the complete updated itinerary. Change only what the request asks for: every other day, stop, time, description and cost stays exactly as it is (copy it unchanged), and day trips, travel between stays, where they sleep and anything booked stay as they are unless the request is about them. Your planning notes should say what you changed and why.`;
  }
  if (trip.redoDay) prompt += redoSection(trip.redoDay);
  if (trip.edit) prompt += editSection(trip.edit);
  if (trip.fix) prompt += fixSection(trip.fix);
  // Servers without schema enforcement only have the prompt to go on.
  if (opts.schema) prompt += `\n\n## JSON schema\n${JSON.stringify(LOCAL_SCHEMA)}`;
  return prompt;
}

/** Fix the stops the planner's checks flagged: only the affected days come back. */
export function fixSection({ itinerary, problems }: NonNullable<Trip["fix"]>) {
  const days = [...new Set(problems.map((p) => p.day))].sort((a, b) => a - b).filter((i) => itinerary.days[i]);
  const others = itinerary.days.map((x, i) => (days.includes(i) ? `${x.date} ${x.city}: (to fix, below)` : `${x.date} ${x.city}: ${x.items.map((it) => it.place).join("; ")}`)).join("\n");
  return `

## The rest of the trip (already planned, keep as is)
${others}

## Days to fix
${days.map((i) => JSON.stringify(itinerary.days[i])).join("\n")}

## Problems found by checking the plan against OpenStreetMap
${problems.map((p) => `- ${itinerary.days[p.day]?.date}: ${p.text}`).join("\n")}

## Fix only these problems
For each problem, change only that stop: replace a place that isn't where the day is with a real place near that day's town (from the lists above if possible), and move a stop that's closed at the planned time to a time it's open, or swap it with another stop or a similar place. Keep everything else on those days as it is, including where they sleep and any transfer. If a must-see can't be moved to an open time on its day, keep it and say so in the day's notes. This overrides the rule about one entry per calendar day: return the itinerary with "days" containing only the ${days.length} day(s) to fix (${days.map((i) => itinerary.days[i].date).join(", ")}), each complete. "summary" is one sentence on what you fixed; leave out "tips", "holidaysAndEvents" and "unused". Your planning notes briefly list what you changed.`;
}

/** A change the travelers asked for, to some days only: the other days as context (names only), those days in full,
 *  and the rule to change nothing the request doesn't ask for. Only those days come back. */
export function editSection({ itinerary, days, request }: NonNullable<Trip["edit"]>) {
  const these = [...new Set(days)].sort((a, b) => a - b).filter((i) => itinerary.days[i]);
  const others = itinerary.days.map((x, i) => (these.includes(i) ? `${x.date} ${x.city}: (to change, below)` : `${x.date} ${x.city}: ${x.items.map((it) => it.place).join("; ")}`)).join("\n");
  const dates = these.map((i) => itinerary.days[i].date).join(", ");
  return `

## The rest of the trip (already planned, keep as is)
${others}

## Day${these.length > 1 ? "s" : ""} to change
${these.map((i) => JSON.stringify(itinerary.days[i])).join("\n")}

## The change the travelers asked for
${request}

## Change only what they asked for
Make exactly this change and nothing else. Every stop, time, description and cost the request doesn't touch stays as it is: copy it unchanged. Moving stops between these days, or swapping them, is fine when that's what they asked for (then give each stop the date it moves to). Keep day trips, travel between stays, where they sleep and anything booked as they are, unless the request is about them. Don't add places they already visit on another day. This overrides the rule about one entry per calendar day: return the itinerary with "days" containing only these ${these.length} day(s) (${dates}), each complete and with the same dates. "summary" is one sentence on what changed; leave out "tips", "holidaysAndEvents" and "unused". Your planning notes briefly say what you changed.`;
}

/** Re-plan one day: the other days as context (names only, to keep it short), the day in full, and what to return. */
function redoSection({ itinerary, day, request }: NonNullable<Trip["redoDay"]>) {
  const d = itinerary.days[day];
  const others = itinerary.days.map((x, i) => (i === day ? `${x.date} ${x.city}: (this day)` : `${x.date} ${x.city}: ${x.items.map((it) => it.place).join("; ")}`)).join("\n");
  return `

## The rest of the trip (already planned, keep as is)
${others}

## Day to re-plan
${JSON.stringify(d)}

## Re-plan only this day
Re-plan ${d.date} (${d.city}). ${request ? `The travelers ask: ${request}` : "Give it a fresh plan with different choices where sensible."} If you research online, look up only what this day needs (a few searches at most).
Keep it consistent with the other days: don't repeat places they visit on another day, and keep where they sleep and any transfer that happens on this day. This overrides the rule about one entry per calendar day: return the itinerary with "days" containing only this one day, dated ${d.date}. "summary" is one sentence on what changed; leave out "tips", "holidaysAndEvents" and "unused". Your planning notes briefly explain the new plan for the day.`;
}
