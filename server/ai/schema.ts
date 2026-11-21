// The JSON schema the itinerary must follow. Claude Code enforces it; local servers get it in the prompt
// (and as a format constraint where they support one).

export const ITINERARY_SCHEMA = {
  type: "object",
  required: ["summary", "destination", "days", "totalEstimatedCost"],
  properties: {
    summary: { type: "string", description: "2-4 sentence overview of the trip. Not the planning notes." },
    destination: { type: "string", description: "Country / countries of the trip, e.g. 'Japan' or 'Portugal & Spain'" },
    localCurrency: { type: "string", description: "ISO code of the local currency, e.g. JPY" },
    totalEstimatedCost: { type: "number" },
    days: {
      type: "array",
      items: {
        type: "object",
        required: ["date", "city", "title", "items", "estimatedCost"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          city: { type: "string" },
          title: { type: "string" },
          estimatedCost: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["time", "place", "description"],
              properties: {
                time: { type: "string", description: "e.g. 09:30" },
                place: { type: "string", description: "Exact Title from the list when fromList is true" },
                fromList: { type: "boolean" },
                description: { type: "string" },
                cost: { type: "number" },
                transport: { type: "string", description: "How to get here from the previous stop" },
                lat: { type: "number", description: "Latitude of the place, best estimate" },
                lng: { type: "number", description: "Longitude of the place, best estimate" },
                group: { type: "string", description: "Only while the travelers split up: short label of the subgroup doing this, e.g. 'Group A'. Omit when everyone is together." },
                people: { type: "number", description: "How many travelers are in that subgroup. Omit when everyone is together." },
                kind: { type: "string", enum: ["sight", "activity", "meal", "transfer", "other"] },
                booking: {
                  type: "string", enum: ["essential", "recommended", "optional"],
                  description: "Only for paid tickets, tours, timed entry or table reservations: essential = sells out or needs a slot, recommended = booking online saves queues or money, optional = easy on the spot",
                },
                bookAhead: { type: "string", description: "With essential/recommended booking: how far ahead, e.g. '2-3 weeks before'" },
                website: { type: "string", description: "Official website or ticket page of a paid place, only if you know it for certain (never guess)" },
              },
            },
          },
          notes: { type: "string" },
        },
      },
    },
    unused: {
      type: "array",
      items: { type: "object", properties: { place: { type: "string" }, reason: { type: "string" } } },
    },
    tips: { type: "array", items: { type: "string" } },
    holidaysAndEvents: {
      type: "array",
      description: "Public holidays, festivals, events and seasonal happenings during the trip",
      items: {
        type: "object",
        required: ["date", "name", "impact"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, or a range like 2026-09-19..2026-10-04" },
          name: { type: "string" },
          where: { type: "string" },
          impact: { type: "string", description: "What it means for the plan (closures, crowds, transit, worth seeing)" },
        },
      },
    },
    sources: { type: "array", items: { type: "string" }, description: "URLs relied on (only when researching online)" },
  },
};

/** Local models can't write free text before a JSON answer, so their notes go in a field (first, so they stream first). */
export const LOCAL_SCHEMA = {
  ...ITINERARY_SCHEMA,
  required: ["planningNotes", ...ITINERARY_SCHEMA.required],
  properties: {
    planningNotes: { type: "string", description: "Your planning notes for the travelers, under 250 words" },
    ...ITINERARY_SCHEMA.properties,
  },
};
