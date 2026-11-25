// A split inside a split: four travel together, one stays at the hotel ("Group A") while three go for sushi ("Group B"),
// and later the three go three ways ("Group B1", "B2", "B3"). The later groups belong to the one they split off from:
// shown inside its column, and their lines on the map carry on from its stops. `who` gives a stop's group ("" when
// everyone is together).

interface Stop { time: string }
type Who<T> = (x: T) => string;

const labelsOf = <T>(items: T[], who: Who<T>) => new Set(items.map(who).filter(Boolean));

/** The group a subgroup split off from: "Group B" for "Group B1" (or "Group B-2") on a day that has a "Group B" too;
 *  "" for a group that split off from everyone. */
export function parentGroup(g: string, labels: Set<string>): string {
  const m = /^(.*[\p{L}])[\s.\-]?\d+$/u.exec(g);
  const p = m ? m[1].trim() : "";
  return p && p !== g && labels.has(p) ? p : "";
}

/** A group and the groups it split off from, nearest first ("Group B1", "Group B"). */
function lineage(g: string, labels: Set<string>): string[] {
  const out: string[] = [];
  for (let at = g; at && !out.includes(at); at = parentGroup(at, labels)) out.push(at);
  return out;
}

/** Whether a stop is on group g's way through the day: done together, or by g, or by a group g split off from (the
 *  sushi the three had together, before one of them went to Akihabara). With g "", only stops done together. */
export function onWay<T>(items: T[], y: T, g: string, who: Who<T>): boolean {
  const gy = who(y);
  return !gy || (!!g && lineage(g, labelsOf(items, who)).includes(gy));
}

/** Of the groups at the two ends of a leg, the one whose line it is: the group that split off further on (the
 *  Akihabara one, coming from the sushi), else the one it leaves from. */
export function lineGroup<T>(items: T[], from: string, to: string, who: Who<T>): string {
  return from && to && lineage(to, labelsOf(items, who)).includes(from) ? to : from || to;
}

/** The order a split's groups are shown and numbered in: the groups that split off from everyone by when they start,
 *  each followed by the groups it splits into later (by their labels). */
export function groupOrder<T extends Stop>(items: T[], who: Who<T>): string[] {
  const labels = labelsOf(items, who);
  const first = (g: string) => items.filter((x) => who(x) === g).map((x) => x.time || "99:99").sort()[0] || "99:99";
  const kids = (p: string) => [...labels].filter((g) => parentGroup(g, labels) === p);
  const out: string[] = [];
  const walk = (g: string) => { out.push(g); kids(g).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(walk); };
  kids("").sort((a, b) => first(a).localeCompare(first(b))).forEach(walk);
  return out;
}
