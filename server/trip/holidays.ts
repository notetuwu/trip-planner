// Public holidays during the trip, from date.nager.at (free, no key).
import type { TripStay } from "../../shared/types";
import { addDays } from "../config";

export interface Holiday {
  date: string;
  name: string;
  localName?: string;
  counties?: string[] | null;
  cc: string;
}

const cache = new Map<string, Omit<Holiday, "cc">[]>();

export async function tripHolidays(stays: TripStay[]): Promise<Holiday[]> {
  const dated = stays.filter((s) => s.start).sort((a, b) => a.start.localeCompare(b.start));
  if (!dated.length) return [];
  const first = dated[0].start, last = dated.at(-1)!;
  const end = addDays(last.start, Number(last.nights) || 0);
  const ccs = [...new Set(stays.map((s) => String(s.cc || "").toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  const years = [...new Set([first.slice(0, 4), end.slice(0, 4)])];
  const out: Holiday[] = [];
  await Promise.allSettled(ccs.flatMap((cc) => years.map(async (y) => {
    const key = `${y}/${cc}`;
    if (!cache.has(key)) {
      const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${key}`, { signal: AbortSignal.timeout(5000) });
      cache.set(key, res.ok ? ((await res.json()) as Omit<Holiday, "cc">[]) : []);
    }
    for (const h of cache.get(key)!) if (h.date >= first && h.date <= end) out.push({ ...h, cc });
  })));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
