// A leg between stays with no way of getting there chosen (a stop added to a route later) on a road trip: they have no
// car on that leg only if they say so, so it is driven too.
import type { TravelMode } from "../../../shared/types";

/**
 * Each stay's way of getting there for the planner: as chosen; where none is and every chosen leg is by car (and they
 * didn't say they get around without one), by car. The first stay is where the trip starts.
 */
export function legModes(stays: { travel?: TravelMode | "" }[], getAround?: string): (TravelMode | "")[] {
  const chosen = stays.slice(1).map((s) => s.travel).filter(Boolean);
  const driving = getAround !== "transit" && chosen.length > 0 && chosen.every((m) => m === "car");
  return stays.map((s, i) => s.travel || (i && driving ? "car" : ""));
}
