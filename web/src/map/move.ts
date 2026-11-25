// Moving a map to something that was clicked: it pans there, zooming in when it's further out than `minZoom`, but
// never out. (Leaflet's flyTo swoops out and back in on the way, even when it ends closer.)
import type * as L from "leaflet";

export function moveTo(m: L.Map, at: L.LatLngExpression, minZoom = 0) {
  const z = Math.max(m.getZoom(), minZoom);
  if (z === m.getZoom()) m.panTo(at, { animate: true, duration: .5 });
  else m.setView(at, z, { animate: true });
}

/** To several spots: centred on them, zoomed in to fit them (up to `maxZoom`) but never out; nothing moves when they're
 *  all in view already. */
export function moveToAll(m: L.Map, pts: L.LatLng[], maxZoom: number, L_: typeof L) {
  if (!pts.length) return;
  const b = L_.latLngBounds(pts);
  if (m.getBounds().pad(-0.1).contains(b)) return;
  const fit = Math.min(maxZoom, m.getBoundsZoom(b.pad(0.3)));
  moveTo(m, b.getCenter(), fit);
}
