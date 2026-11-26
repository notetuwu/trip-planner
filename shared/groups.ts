// Models sometimes write a split into the text ("Group A (2 people): JR limited express…") without filling in the
// stop's "group" field, so the day shows as one long list. This reads the label from the text instead.

interface Stop { place: string; description?: string; group?: string; people?: number }

/** "Group A (2 people):", "GROUP B.", "Group 2 –" at the start of a text: the label and the head count. */
const LABEL = /^\s*(group\s+[a-z0-9])\b\s*(?:\(\s*(\d+)[^)]*\))?\s*[:.\-–—]\s*/i;

/** Fills in "group" (and "people") from labels at the start of stops' descriptions or names; true if any changed. */
export function groupsFromText(days: { items: Stop[] }[]): boolean {
  let changed = false;
  for (const d of days) {
    if (d.items.some((x) => x.group || (x as { who?: string[] }).who?.length)) continue; // the model used the fields: trust them
    const found = d.items.map((x) => x.description?.match(LABEL) || x.place.match(LABEL));
    if (new Set(found.filter(Boolean).map((m) => m![1].toLowerCase())).size < 2) continue; // not a split
    d.items.forEach((x, i) => {
      const m = found[i];
      if (!m) return;
      x.group = m[1].replace(/\s+/, " ").replace(/^group/i, "Group").replace(/ ([a-z])$/, (_, c: string) => ` ${c.toUpperCase()}`);
      if (m[2] && !x.people) x.people = Number(m[2]);
      // The label is now shown as the group's column; drop it from the text.
      if (x.description?.match(LABEL)) x.description = x.description.replace(LABEL, "");
      else x.place = x.place.replace(LABEL, "");
      changed = true;
    });
    // A group's head count, said once, holds for all its stops.
    const counts = new Map<string, number>();
    for (const x of d.items) if (x.group && x.people) counts.set(x.group, x.people);
    for (const x of d.items) if (x.group && !x.people && counts.has(x.group)) x.people = counts.get(x.group);
  }
  return changed;
}
