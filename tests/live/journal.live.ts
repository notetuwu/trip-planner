// Live: the journal's review step with a real model (npm run test:live -- tests/live/journal.live.ts). Made-up days.
//   MODEL=<model id> (default: Claude Code's default model, on your plan)
import { describe, expect, it } from "vitest";
import { reviewJournalDay } from "../../server/trip/journal";

const model = process.env.MODEL || "default";
const planned = {
  date: "2030-11-02", city: "Lakeside", title: "Arrival and a quick dinner", estimatedCost: 26,
  items: [
    { time: "16:30", place: "Check-in & rest at Harbour Hotel", description: "Check in and rest.", kind: "other" as const },
    { time: "19:00", place: "Burger Barn (Quay Street)", description: "Quick dinner.", kind: "meal" as const, cost: 20 },
    { time: "20:00", place: "Back to hotel", description: "Two stops on the tram.", kind: "transfer" as const, cost: 6 },
  ],
};
const ask = (text: string, extra: object = {}) => reviewJournalDay({ model, date: planned.date, text, at: 1, planned, people: ["Mia", "Tom", "Sam"], currency: "EUR", localCurrency: "EUR", city: "Lakeside", ...extra }, () => {});

describe("the journal with a real model", () => {
  it("a note on one change keeps the rest of the day as planned", async () => {
    const { day } = await ask("we didnt go to burger barn, instead we went to the fried chicken place next door");
    console.log(JSON.stringify(day, null, 1));
    expect(day.items).toHaveLength(3);
    expect(day.items[0]).toEqual(planned.items[0]);
    expect(day.items[2]).toEqual(planned.items[2]);
    expect(day.items[1].place).toMatch(/chicken/i);
    expect(day.kept).toEqual([0, 2]);
  });

  it("an account of the whole day replaces the planned sights, with the expenses it states", async () => {
    const { day } = await ask("Sam only arrives tomorrow. We skipped the burger place and took the tram to the old market, walked through the stalls and ended in a bookshop. There I bought 2 books for 45€ in total, Tom bought a map for 18€. We had soup at a stall, no idea what it cost. It's 21:00 now and we got back about half an hour ago.");
    console.log(JSON.stringify(day, null, 1));
    expect(day.items.some((x) => /Burger Barn/.test(x.place))).toBe(false);
    expect(day.items[0]).toEqual(planned.items[0]);
    expect(day.expenses).toEqual(expect.arrayContaining([expect.objectContaining({ amount: 45, paidBy: "Mia" }), expect.objectContaining({ amount: 18, paidBy: "Tom" })]));
    expect(day.expenses).toHaveLength(2);
  });
});
