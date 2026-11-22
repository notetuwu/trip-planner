// The trip as sent to POST /api/itinerary.
import type { TripRequest } from "../../../shared/types";
import { groupSize, keptElsewhere, listSuggest, state, tickedLists, whoFor } from "../core/state";
import { stayLoc } from "../geo/locate";
import { mustSeeRoutes } from "../places/route";
import { fieldValues } from "../trip/fields";

/** What to change: a revision of the whole plan, or a fresh plan for one day. */
export type Change = Pick<TripRequest, "revise" | "redoDay" | "fix" | "edit">;

export function tripRequest(change: Change = {}): TripRequest {
  const marked = (m: string) => Object.keys(state.marks).filter((t) => state.marks[t] === m);
  return {
    ...fieldValues(),
    budgetPer: "person",
    // Lists on the map whose places the planner may pick from as suggestions; from the others just the stars go (as kept places, below).
    list: tickedLists().filter(listSuggest)[0] || "",
    lists: tickedLists().filter(listSuggest),
    extraPlaces: [
      ...state.customPlaces.map(({ title, note, address, lat, lng }) => ({ title, note, address, lat, lng, picked: true })),
      // Must-sees from lists that aren't suggested to the planner (hidden, or suggestions off).
      ...keptElsewhere().map(({ title, note, tags, comment, address, lat, lng }) => ({ title, note, tags, comment, address, lat, lng })),
    ],
    stays: state.stays.map((s) => ({
      city: s.city, start: s.start, nights: s.nights, hotel: s.hotel, country: stayLoc(s)?.country, cc: stayLoc(s)?.cc,
      lat: stayLoc(s)?.lat, lng: stayLoc(s)?.lng,
      travel: s.travel || "", dayTrips: (s.dayTrips || []).filter((t) => t.place).map((t) => ({ place: t.place, mode: t.mode || "" })),
    })),
    research: state.research !== false,
    mustSee: marked("must"),
    mustSeeWho: Object.fromEntries(marked("must").filter((t) => whoFor(t) < groupSize()).map((t) => [t, whoFor(t)])),
    mustSeeRoute: mustSeeRoutes(marked("must")),
    skip: marked("skip"),
    ...change,
  };
}
