// Icons from Lucide (lucide.dev, ISC license) as inline SVG strings, sized to the text (1em) and drawn in its colour.
// Only the icons listed here end up in the bundle.
import {
  ArrowLeftRight, ArrowUp, ArrowUpRight, BedDouble, Bike, Bus, CalendarDays, Car, Clock, Cloud, CloudDrizzle, CloudFog,
  Check, CloudLightning, CloudRain, CloudSnow, CloudSun, Copy, CornerDownRight, Download, ExternalLink, FileText, Footprints, Hotel,
  KeyRound, Map, MapPin, Monitor, Moon, Plane, Plus, Printer, RefreshCw, Route, Search, Ship, Smartphone, Star, Sun,
  Ticket, TrainFront, Trash2, TriangleAlert, Users, X,
} from "lucide";

type IconNode = [string, Record<string, string | number | undefined>][];

const ICONS = {
  arrowLeftRight: ArrowLeftRight, arrowUp: ArrowUp, arrowUpRight: ArrowUpRight, bed: BedDouble, bike: Bike, bus: Bus,
  calendar: CalendarDays, car: Car, check: Check, copy: Copy, clock: Clock, cloud: Cloud, cloudDrizzle: CloudDrizzle, cloudFog: CloudFog,
  cloudLightning: CloudLightning, cloudRain: CloudRain, cloudSnow: CloudSnow, cloudSun: CloudSun, dayTrip: CornerDownRight,
  download: Download, external: ExternalLink, file: FileText, walk: Footprints, hotel: Hotel, key: KeyRound, map: Map,
  pin: MapPin, monitor: Monitor, moon: Moon, plane: Plane, plus: Plus, printer: Printer, refresh: RefreshCw, route: Route,
  search: Search, ship: Ship, phone: Smartphone, star: Star, sun: Sun, ticket: Ticket, train: TrainFront, trash: Trash2,
  warn: TriangleAlert, users: Users, x: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => `${k}="${v}"`).join(" ");

/** An icon as SVG markup; extra classes go on the <svg> (it always has class "i"). */
export function icon(name: IconName, cls = "") {
  const inner = (ICONS[name] as IconNode).map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
  return `<svg class="i${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** Fills <i data-icon="name"></i> placeholders in static HTML. */
export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("i[data-icon]")) {
    const name = el.dataset.icon as IconName;
    if (name in ICONS) el.outerHTML = icon(name, el.className);
  }
}

/** The small "opens elsewhere" arrow after link text. */
export const ext = () => icon("arrowUpRight", "ext");
