// The planning prompt. Sections with data come from prompt-sections.ts; this file holds the instructions.
import type { Place } from "../../shared/types";
import { holidayLines, hasChosenModes, nearbySection, placeLines, stayLines } from "./prompt-sections";
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

export function buildPrompt(trip: Trip, places: Place[], opts: PromptOptions = {}) {
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
  ? `Research online while you plan, using web search and web fetch: opening hours and closing days on the actual dates, current ticket prices, festivals and events during the trip, transport options, times and prices between the cities, and anything else that is date-dependent or uncertain. Prefer official websites. Focus on the must-sees, day trips and transfers rather than looking up every café; about 10-25 searches is plenty. Where you could not verify something, say so in the item's description.`
  : `Use your own knowledge of the destination (geography, opening days, holidays, transit, typical prices, local customs).${!json && !opts.outputTool ? " Do not use tools; just answer." : ""}`}

${json
  ? `If you think before answering, keep it brief (a few short paragraphs): most of your effort belongs in the itinerary itself. Answer with one JSON object only, matching the schema${opts.schema ? " at the end" : ""}. Start with "planningNotes": notes for the travelers`
  : `${research ? "When your research is done, and right before" : "Before"} returning the itinerary, write your planning notes as plain text in your reply (not inside the itinerary; its "summary" is just a 2-4 sentence overview) for the travelers`} (they can expand them to see how you approached the plan): how you split the days between cities and day trips, where the must-sees went and why, what the holidays and events mean for the plan, budget trade-offs, and anything you had to compromise on or leave out. Use short paragraphs or "- " bullets (one bullet per line), under 250 words.${json ? "" : giveBack}

## Stays (in order)
${stayLines(trip)}

## Constraints
- Daily budget: ${trip.dailyBudget} ${trip.currency} per day for ${trip.travelers} traveler(s), covering activities, food and local transport (accommodation is already paid, intercity transfers count toward the day they happen). It is a ceiling, not a target.
- Pace: ${trip.pace}
- Interests / preferences: ${trip.interests || "none given"}
- Extra notes: ${trip.notes || "none"}
${trip.researchNotes ? `
## Web research findings (gathered online just now; trust these over your own memory)
${trip.researchNotes}
` : ""}${holidays ? `
## Public holidays during the trip (official list from date.nager.at)
Plan around these: closed shops and museums, changed transit timetables, crowds, and celebrations worth seeing. Regional holidays only apply in the listed states/cantons.
${holidays}
` : ""}
## Saved places
${places.length ? `Build the itinerary primarily from these. Places marked [MUST SEE] must be included. Never schedule [SKIP] places. Hotels in the list are accommodation candidates, not activities. Day trips from a base city are fine if reasonable. Add meals and a few unlisted highlights to fill the days; set fromList=false for those.
Places marked "[MUST SEE for N of M travelers]" only interest part of the group. You may split the group up for those: the N go there while the others do something else (ideally another place only they want, so split places pair up). Batch split places into as few split sessions as is sensible and bring everyone back together afterwards. While split, give every item a "group" label (e.g. "Group A", "Group B") and "people" count, and list each subgroup's items in time order; items done together have no group. You can also skip splitting and take everyone if that is clearly simpler.
${placeLines(trip, places)}` : "No saved places; choose the best things to do yourself (fromList=false)."}
${nearby ? `
## Real places around each stay (from OpenStreetMap)
These exist, with exact locations. Use them for sights and especially for meals, writing the name exactly as listed and copying its location into "lat"/"lng". Sights are within about 8 km, food within about 2.5 km of where you sleep. Each list belongs to its stay: only use a place on days spent at that stay (or passing right by it), never on a day in another city, even if the name sounds generic.
${nearby}
` : ""}
## What every day must look like
- Only real places: every named stop must exist under exactly that name (from the saved places, the lists above, or your research). Never make up names for restaurants, cafés or sights. If you don't know a real place for a meal, write a generic stop such as "Lunch around the Marktplatz" instead of inventing one.
- ${STOPS_PER_DAY[pace]} sights or activities per full day, plus meals: a specific, named place for lunch and for dinner (and breakfast when not at the hotel) that fits the interests and dietary needs. Arrival and departure days can be lighter, but still plan the hours that are free.
- "time": the start time in 24-hour "HH:MM" only, nothing else. Items in chronological order with realistic durations, travel time between them and opening hours respected.
- "transport": how to get there from the previous stop, with mode or line and minutes, e.g. "Tram 1 from Hauptbahnhof, 12 min" or "Walk, 5 min".
- "cost": on every item, for the whole group (0 if free): tickets, meals, fares. The day's "estimatedCost" is the sum of its item costs. Don't pad days to reach the budget.
- "description": what to do there and why it's worth it, with practical details (opening hours, whether to book ahead, best time to go, what to order).
- "kind" on every item: sight, activity, meal, transfer or other. A scenic ride that is an attraction in itself (a cog railway or cable car up a mountain, a boat tour) is an activity, not a transfer.
- "booking" on everything that costs money to get in (museums, castles, tours, cable cars, timed entry, table reservations), even when you simply pay at the door; omit it only for free places: "essential" when it sells out or needs a timed slot, "recommended" when booking online saves queueing or money, "optional" when tickets are easy to get on the spot. With essential or recommended, "bookAhead" says how far ahead, e.g. "2-3 weeks before" or "the day before". For paid places, "website" is the official ticket page or website (e.g. the operator's own site, not a reseller), only when you know it for certain${research ? " or found it online" : ""}; leave it out rather than guess.
- Where a place lists its opening hours ("hours …", OpenStreetMap syntax), schedule it while it's open on that weekday.
- "notes" on the day: anything that affects it, such as holidays, closures (e.g. museums closed on Mondays), markets, festivals, weather and season, bookings to make ahead, or the day going over budget.
- On travel days between cities, the transfer is its own item with departure time, duration, operator or route and price. Name it "<from> → <to> (<mode>)", e.g. "Padua → Milan (car)". Plan around check-out (about 10:00) and check-in (about 15:00).${hasChosenModes(trip) ? `
- Where the stays above say how the travelers get somewhere ("chosen by the travelers"), use exactly that mode; don't swap it for another. By car: the route and main roads, driving time, distance, tolls or vignettes, fuel and parking costs, and a worthwhile stop on the way if there is one. By train or bus: a real connection with operator, departure time, duration and fare, and whether to book ahead. Day trips with a chosen mode are their own outbound and return items ("Milan → Rome (train)", later "Rome → Milan (train)").` : ""}
- Road distances and driving times given with the stays come from a routing service: trust them over your own idea of geography or borders. If a drive is longer than one travel day allows, don't pretend it fits: say so plainly in the planning notes and plan that day around the drive (and suggest how to make it work, e.g. extra nights on the way).
- Day trips and other long excursions (anything more than about 30-45 minutes away from where you sleep) go on full days only, never on a travel day: changing cities and doing a day trip on the same day is exhausting. Travel days get the transfer plus light sightseeing near the hotel or a stop on the way that lies directly on the route. For example, with 2 nights in Padua the one full day there is the day for Venice. If a must-see day trip fits no full day, say so in the notes (or list it in "unused") rather than squeezing it into a travel day.

## Trip-wide extras
- "holidaysAndEvents": every public holiday, festival, major event or seasonal highlight in the visited places during the trip, with what it means for the plan.
- "tips": 6-10 specific, practical tips for this trip: money and payment, transport passes or tickets worth buying (with prices; for things bought online, such as a motorway vignette, a toll account or a rail pass, end the tip with the official website to buy it, only when you know it for certain${research ? " or found it online" : ""}), reservations to make and how far ahead, etiquette, SIM/data, luggage, tipping.
- "unused": saved places you could not fit, with a short reason.${research ? `
- "sources": the URLs you relied on most.` : ""}

## Output rules
- "destination": the country or countries of the trip. "localCurrency": the local currency's ISO code.
- One entry in "days" for every calendar day from the first arrival to the final departure day, with dates in YYYY-MM-DD.
- "place" is only the place's name. For items from the list it must be the exact Title as written above, without the details in brackets or braces.
- Give every item "lat"/"lng" coordinates (4 decimals) so it can be shown on a map.
- All costs in ${trip.currency}.
- Group nearby places on the same day to minimise transit.
- If the group splits for part of a day (including splits mentioned in the notes), use "group"/"people" on those items as described above.`;

  if (trip.revise?.itinerary && trip.revise?.request) {
    prompt += `

## Current itinerary
${JSON.stringify(trip.revise.itinerary)}

## Requested changes
${trip.revise.request}

Apply the requested changes to the current itinerary and return the complete updated itinerary. Keep everything the request doesn't touch as it is. Your planning notes should explain what you changed and why.`;
  }
  if (trip.redoDay) prompt += redoSection(trip.redoDay);
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
