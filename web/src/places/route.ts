// Where each must-see sits on the route (from the map's coordinates), plus the travelers' on-the-way / from-stay choice.
import { type RouteStay, routeFor } from "../../../shared/route";
import type { MustSeeRoute } from "../../../shared/types";
import { session, state } from "../core/state";
import { placeLoc, stayLoc } from "../geo/locate";
import { geo, geoKey } from "../geo/geocode";

const routeStays = (): (RouteStay | null)[] => state.stays.map((s) => {
  const l = stayLoc(s);
  const trips = (s.dayTrips || []).filter((t) => t.place && geo[geoKey(t.place)]).map((t) => ({ lat: geo[geoKey(t.place)]!.lat, lng: geo[geoKey(t.place)]!.lng, place: t.place }));
  return l && s.city ? { lat: l.lat, lng: l.lng, city: s.city, start: s.start, nights: Number(s.nights) || 0, trips } : null;
});

export function mustSeeRoute(title: string, stays = routeStays()): MustSeeRoute | undefined {
  const p = session.places.find((x) => x.title === title), loc = p && placeLoc(p);
  const how = state.how?.[title];
  if (!loc) return how ? { how, onWay: false } : undefined;
  return { ...routeFor(loc, stays), how };
}

/** Route info for every must-see, for the plan request. */
export function mustSeeRoutes(titles: string[]) {
  const stays = routeStays();
  return Object.fromEntries(titles.map((t) => [t, mustSeeRoute(t, stays)]).filter(([, r]) => r)) as Record<string, MustSeeRoute>;
}
