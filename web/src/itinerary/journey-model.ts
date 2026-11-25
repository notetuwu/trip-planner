// Which stops of a travel day are the journey from one stay to the next: the rides (metro, Shinkansen, the taxi up to the
// hotel) and checking out and in around them. Consecutive ones form a run, shown as one card; a stop on the way (lunch,
// a sight) is a normal stop between two runs. No page state here, so the tests can use it.
import type { ItineraryItem } from "../../../shared/types";

/** A stop whose name is a ride ("Shinkansen Shin-Osaka to Odawara", "Uber to the hotel"), whatever kind the plan gave
 *  it: on a travel day that's part of the journey. */
const RIDE = /\b(shinkansen|nozomi|hikari|kodama|limited express|express train|train|railway|metro|subway|tram|bus|coach|ferry|boat|flight|fly|taxi|uber|cab|drive|driving|transfer|ropeway|cable car)\b/i;
export const namesRide = (x: ItineraryItem) => x.kind !== "meal" && RIDE.test(x.place);

/** Checking out, checking in, arriving: the ends of the journey, part of its card. */
const ENDS = /\b(check[- ]?(in|out)|checkout|checkin|arrive|arriving|arrival)\b/i;

export interface JourneyRun {
  /** The items' indices in the day, in order (first and last are where the card starts and ends). */
  items: number[];
}

/** The day's journey runs: consecutive transfers and check-outs or check-ins (not while the group is split), each with
 *  at least one ride. `isLeg` says whether a stop is a ride. */
export function journeyRuns(items: ItineraryItem[], isLeg: (x: ItineraryItem) => boolean): JourneyRun[] {
  const runs: JourneyRun[] = [];
  let run: number[] = [];
  const flush = () => { if (run.some((i) => isLeg(items[i]))) runs.push({ items: run }); run = []; };
  items.forEach((x, i) => {
    if (!x.group && (isLeg(x) || ENDS.test(x.place))) run.push(i);
    else flush();
  });
  flush();
  return runs;
}

const minutes = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };

/** From the first timed stop of the runs to the last ("09:00 → 16:13"), and the cost of them all. */
export function journeySpan(items: ItineraryItem[], runs: JourneyRun[]): { from?: string; to?: string; cost: number } {
  const all = runs.flatMap((r) => r.items).map((i) => items[i]);
  const timed = all.filter((x) => minutes(x.time) != null);
  return {
    ...(timed.length >= 2 ? { from: timed[0].time.slice(0, 5), to: timed[timed.length - 1].time.slice(0, 5) } : {}),
    cost: all.reduce((n, x) => n + (Number(x.cost) || 0), 0),
  };
}

/** Where a new journey's stops go in the day: by time among the timed stops, else after any check-out at the start. */
export function insertAt(items: ItineraryItem[], time: string): number {
  const t = minutes(time);
  if (t != null) {
    const at = items.findIndex((x) => (minutes(x.time) ?? -1) > t);
    return at < 0 ? items.length : at;
  }
  let i = 0;
  while (i < items.length && /check[- ]?out|checkout/i.test(items[i].place)) i++;
  return i;
}
