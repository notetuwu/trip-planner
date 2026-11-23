// Bookings: fixed points in the prompt, and always on their day after planning.
import { describe, expect, it } from "vitest";
import { bookingsSection } from "../server/ai/prompt-sections";
import { ensureBookings } from "../server/ai/output";

const bookings = [
  { name: "teamLab Borderless", date: "2026-11-14", from: "10:30", to: "12:30", cost: 120, countCost: true },
  { name: "Kojima Productions Expo", date: "2026-11-14", cost: 40, countCost: false },
];

describe("bookings", () => {
  it("go into the prompt as fixed points", () => {
    const s = bookingsSection({ bookings, currency: "EUR" });
    expect(s).toContain("## Already booked");
    expect(s).toContain("- 2026-11-14 (Sat), 10:30-12:30: teamLab Borderless; cost 120 EUR");
    expect(s).toContain("any time that day: Kojima Productions Expo; cost 40 EUR (already paid: put 0 as its cost)");
    expect(bookingsSection({ bookings: [] })).toBe("");
  });
  it("end up on their day, at their time, with their cost", () => {
    const it2: any = { days: [{ date: "2026-11-14", items: [
      { time: "09:00", place: "Breakfast", cost: 10 },
      { time: "15:00", place: "teamLab Borderless (Azabudai Hills)", cost: 30, booking: "essential", bookAhead: "2 weeks" },
    ] }] };
    ensureBookings(it2, bookings);
    const items = it2.days[0].items;
    expect(items.map((x: any) => `${x.time} ${x.place}`)).toEqual(["09:00 Breakfast", "10:30 teamLab Borderless (Azabudai Hills)", " Kojima Productions Expo"]);
    expect(items[1]).toMatchObject({ cost: 120 });
    expect(items[1].booking).toBeUndefined();
    expect(items[1].description).toMatch(/^Already booked \(10:30-12:30\)/);
    expect(items[2].cost).toBe(0);
    expect(it2.days[0].estimatedCost).toBe(130);
  });
});
