// The trip as sent to POST /api/itinerary.
import type { Itinerary, TripRequest } from "../../../shared/types";
import { groupSize, state, whoFor } from "../core/state";
import { stayLoc } from "../geo/locate";
import { fieldValues } from "../trip/fields";

export function tripRequest(revise?: { itinerary: Itinerary; request: string }): TripRequest {
  const marked = (m: string) => Object.keys(state.marks).filter((t) => state.marks[t] === m);
  return {
    ...fieldValues(),
    list: state.list,
    extraPlaces: state.customPlaces.map(({ title, note, address, lat, lng }) => ({ title, note, address, lat, lng, picked: true })),
    stays: state.stays.map((s) => ({
      city: s.city, start: s.start, nights: s.nights, hotel: s.hotel, country: stayLoc(s)?.country, cc: stayLoc(s)?.cc,
      travel: s.travel || "", dayTrips: (s.dayTrips || []).filter((t) => t.place).map((t) => ({ place: t.place, mode: t.mode || "" })),
    })),
    research: state.research !== false,
    mustSee: marked("must"),
    mustSeeWho: Object.fromEntries(marked("must").filter((t) => whoFor(t) < groupSize()).map((t) => [t, whoFor(t)])),
    skip: marked("skip"),
    revise,
  };
}
