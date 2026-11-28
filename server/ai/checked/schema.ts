// The checked planner's output contract, as JSON schemas the providers enforce (server/ai/ask.ts) and code checks
// again (validate.ts). Written in the subset every provider takes: every key required, "unknown" as null (never a
// made-up value), additionalProperties false, no numeric or string constraints (those are checked in code).
// The model is asked only for what it can know: times, names, how to get there, costs. Where a stop is, is worked out
// in code from its name (resolve.ts), so there are no coordinates or addresses to invent.
// The answers are turned into the app's usual Itinerary (shared/types.ts) by planner.ts, so stored plans and the page
// don't change; the only new field there is the optional ItineraryItem.durationMinutes.

/** Bumped whenever the schemas or prompts change in a way that makes runs incomparable (shown with each plan). */
export const CHECKED_VERSION = "checked-2";

const str = { type: "string" } as const;
const nullable = (type: string) => ({ type: [type, "null"] });
const strs = { type: "array", items: str } as const;
const obj = (properties: Record<string, object>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const KINDS = ["sight", "activity", "meal", "transfer", "other"] as const;

/** What the stop schema needs to know about the trip: whether the group can split up, and whether people have names. */
export interface SchemaOptions { splits: boolean; named: boolean }

/** One stop of a day. Cost null = unknown (not free). */
export function itemSchema({ splits, named }: SchemaOptions) {
  return obj({
    time: { type: "string", description: "Start time, 24-hour HH:MM" },
    durationMinutes: { type: "integer", description: "How long they stay, in minutes (a ride: the whole journey)" },
    place: { type: "string", description: "The place's name only, exactly as listed when it's from the lists; a ride as \"<from> → <to> (<mode>)\"" },
    kind: { type: "string", enum: [...KINDS] },
    fromList: { type: "boolean", description: "true when it is one of the travelers' saved places" },
    description: str,
    transport: { type: "string", description: "How they get here from the previous stop: mode and minutes" },
    cost: { ...nullable("number"), description: "For the whole group; 0 if free; null if not known" },
    costPer: { type: ["string", "null"], enum: ["person", "group", null] },
    booking: { type: ["string", "null"], enum: ["essential", "recommended", "optional", null] },
    bookAhead: nullable("string"),
    ...(splits ? (named
      ? { who: { type: ["array", "null"], items: str, description: "Names of those who do it, only when not everyone does" } }
      : { group: { ...nullable("string"), description: "\"Group A\", only when not everyone does it" }, people: nullable("integer") }) : {}),
  });
}

export function daySchema(o: SchemaOptions) {
  return obj({
    date: { type: "string", description: "YYYY-MM-DD" },
    title: str,
    notes: { type: "string", description: "Closures, holidays, bookings to make, anything not verified" },
    items: { type: "array", items: itemSchema(o) },
  });
}

/** The answer to writing (or repairing) a batch of days. */
export const daysSchema = (o: SchemaOptions) => obj({ days: { type: "array", items: daySchema(o) } });

/** The answer to the first step: which day gets what, before any day is written. */
export const OUTLINE_SCHEMA = obj({
  destination: { type: "string", description: "Country or countries of the trip" },
  summary: { type: "string", description: "2-4 sentence overview" },
  planningNotes: { type: "string", description: "How the days were split, where the must-sees went, conflicts and what was left out (under 200 words)" },
  tips: strs,
  days: {
    type: "array",
    items: obj({
      date: str,
      title: str,
      theme: { type: "string", description: "One sentence: the area or idea of the day" },
      places: { ...strs, description: "Exact names of the places for this day, in a sensible order (on travel days the stops on the way too)" },
    }),
  },
  unused: { type: "array", items: obj({ place: str, reason: str }) },
  events: { type: "array", items: obj({ date: { type: "string", description: "YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD" }, name: str, where: str, impact: str }) },
});

/** Strips the nulls the strict schema asks for, so the app gets its usual optional fields. */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = dropNulls(v);
    return out as T;
  }
  return value;
}
