import { describe, expect, it } from "vitest";
import { type Expense, balances, cleanExpense, inTrip, joinExpenses, mergeFromPhone, settleUp, spending, standOf } from "../shared/expenses";
import { describePart } from "../shared/edits";
import { merge3 } from "../shared/merge";

const fx = { EUR: 1, JPY: 160, USD: 1.1 };
const ex = (o: Partial<Expense>): Expense => ({ what: "x", amount: 10, currency: "EUR", date: "2026-05-01", ...o });
const people = ["Mia", "Tom", "Ava"];

describe("expenses", () => {
  it("converts to the trip's currency: as paid, by its own rate, or by today's", () => {
    expect(inTrip(ex({ amount: 12 }), "EUR", fx)).toBe(12);
    expect(inTrip(ex({ amount: 1600, currency: "JPY" }), "EUR", fx)).toBeCloseTo(10);
    expect(inTrip(ex({ amount: 1600, currency: "JPY", rate: 0.005, rateTo: "EUR" }), "EUR", fx)).toBeCloseTo(8);
    // A rate for another trip currency than now: today's rate instead.
    expect(inTrip(ex({ amount: 1600, currency: "JPY", rate: 0.005, rateTo: "USD" }), "EUR", fx)).toBeCloseTo(10);
    expect(inTrip(ex({ currency: "THB" }), "EUR", fx)).toBeNull();
  });

  it("works out balances and the fewest payments back", () => {
    const list = [
      ex({ amount: 90, paidBy: "Mia" }),                    // 30 each
      ex({ amount: 30, paidBy: "Tom", split: ["Tom", "Ava"] }), // 15 each for Tom and Ava
    ];
    const bal = balances(list, people, "EUR", fx);
    expect(bal.Mia).toBeCloseTo(60);
    expect(bal.Tom).toBeCloseTo(-15);
    expect(bal.Ava).toBeCloseTo(-45);
    expect(settleUp(bal, "EUR")).toEqual([{ from: "Ava", to: "Mia", amount: 45 }, { from: "Tom", to: "Mia", amount: 15 }]);
  });

  it("evens out once a payment back is noted, and leaves it out of the spending", () => {
    const list = [ex({ amount: 100, paidBy: "Mia", split: ["Mia", "Tom"] }), ex({ amount: 50, paidBy: "Tom", split: ["Mia"], kind: "settle" })];
    expect(settleUp(balances(list, ["Mia", "Tom"], "EUR", fx), "EUR")).toEqual([]);
    const s = spending(list, ["Mia", "Tom"], "EUR", fx);
    expect(s.total).toBe(100);
    expect(s.share).toEqual({ Mia: 50, Tom: 50 });
  });

  it("a covered person owes nothing; the payer takes their share and the others still owe theirs", () => {
    const list = [ex({ amount: 90, paidBy: "Mia", covered: ["Ava"] })];
    const bal = balances(list, people, "EUR", fx);
    expect(bal.Mia).toBeCloseTo(30);
    expect(bal.Tom).toBeCloseTo(-30);
    expect(bal.Ava).toBeCloseTo(0);
    expect(settleUp(bal, "EUR")).toEqual([{ from: "Tom", to: "Mia", amount: 30 }]);
    expect(spending(list, people, "EUR", fx).share).toEqual({ Mia: 60, Tom: 30, Ava: 0 });
    // Covering someone it wasn't for, or the payer themselves, changes nothing.
    expect(balances([ex({ amount: 90, paidBy: "Mia", split: ["Mia", "Tom"], covered: ["Ava", "Mia"] })], people, "EUR", fx)).toEqual({ Mia: 45, Tom: -45, Ava: 0 });
  });

  it("mixed: the payer covers one, another paid their own, the rest owe", () => {
    // Four tickets of 20: Mia pays, covers Tom, Ava bought her own, Leo owes Mia.
    const four = ["Mia", "Tom", "Ava", "Leo"];
    const e = ex({ amount: 80, paidBy: "Mia", covered: ["Tom"], own: ["Ava"] });
    const bal = balances([e], four, "EUR", fx);
    expect(bal).toEqual({ Mia: 20, Tom: 0, Ava: 0, Leo: -20 });
    expect(settleUp(bal, "EUR")).toEqual([{ from: "Leo", to: "Mia", amount: 20 }]);
    expect(spending([e], four, "EUR", fx)).toMatchObject({ total: 80, share: { Mia: 40, Tom: 0, Ava: 20, Leo: 20 } });
    expect(["Mia", "Tom", "Ava", "Leo"].map((n) => standOf(e, n, four))).toEqual(["payer", "covered", "own", "owes"]);
  });

  it("someone who already paid the payer back owes nothing more", () => {
    const four = ["Mia", "Tom", "Ava", "Leo"];
    const e = ex({ amount: 80, paidBy: "Mia", back: ["Leo"], covered: ["Tom"] });
    const bal = balances([e], four, "EUR", fx);
    expect(bal).toEqual({ Mia: 20, Tom: 0, Ava: -20, Leo: 0 });
    expect(standOf(e, "Leo", four)).toBe("back");
    expect(spending([e], four, "EUR", fx).share).toEqual({ Mia: 40, Tom: 0, Ava: 20, Leo: 20 });
  });

  it("each paying their own counts as spent, but nobody owes anybody", () => {
    const list = [ex({ amount: 60, each: true, covered: ["Tom"] })];
    expect(settleUp(balances(list, people, "EUR", fx), "EUR")).toEqual([]);
    expect(spending(list, people, "EUR", fx)).toMatchObject({ total: 60, share: { Mia: 20, Tom: 20, Ava: 20 } });
  });

  it("rounds to the currency's smallest unit (none for yen)", () => {
    const bal = balances([ex({ amount: 1000, currency: "JPY", paidBy: "Mia" })], people, "JPY", fx);
    expect(settleUp(bal, "JPY")).toEqual([{ from: "Tom", to: "Mia", amount: 333 }, { from: "Ava", to: "Mia", amount: 333 }]);
  });

  it("joins expenses from another copy without touching the ones already here", () => {
    const { expenses, added } = joinExpenses({ a: ex({ what: "Lunch" }) }, { a: ex({ what: "Changed" }), b: ex({ what: "Train" }), c: { amount: -1 } });
    expect(added).toBe(1);
    expect(expenses.a.what).toBe("Lunch");
    expect(expenses.b.what).toBe("Train");
    expect(cleanExpense({ what: "Bus", amount: "3", currency: "eur", date: "2026-05-01" })).toBeNull();
  });

  it("brings the phone's changes back: added, changed and removed there; the app's own later changes kept", () => {
    const base = { a: ex({ what: "Lunch" }), b: ex({ what: "Train" }), c: ex({ what: "Museum" }), d: ex({ what: "Ferry" }) };
    const app = { a: ex({ what: "Lunch" }), b: ex({ what: "Train" }), c: ex({ what: "Museum", amount: 15 }), d: ex({ what: "Ferry", amount: 30 }) };
    const phone = { a: ex({ what: "Lunch", paidBy: "Tom" }), c: ex({ what: "Museum" }), d: ex({ what: "Ferry", amount: 40 }), e: ex({ what: "Gelato" }) };
    const m = mergeFromPhone(base, app, phone);
    expect(m.expenses.a.paidBy).toBe("Tom");           // changed on the phone
    expect(m.expenses.b).toBeUndefined();              // removed on the phone
    expect(m.expenses.c.amount).toBe(15);              // only the app changed it
    expect(m.expenses.d.amount).toBe(30);              // both changed: the app's kept
    expect(m.expenses.e.what).toBe("Gelato");          // added on the phone
    expect({ added: m.added, changed: m.changed, removed: m.removed, clashes: m.clashes }).toEqual({ added: 1, changed: 1, removed: 1, clashes: 1 });
    // An older file without a base only adds.
    expect(Object.keys(mergeFromPhone(undefined, app, phone).expenses).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("joins two people's expenses without a clash, and says what changed", () => {
    const base = { expenses: { a: ex({ what: "Lunch" }) } };
    const mine = { expenses: { a: ex({ what: "Lunch" }), b: ex({ what: "Train" }) } };
    const theirs = { expenses: { a: ex({ what: "Lunch", amount: 12 }), c: ex({ what: "Museum" }) } };
    const m = merge3(base, mine, theirs);
    expect(m.clashes).toEqual([]);
    expect(Object.keys((m.value as any).expenses).sort()).toEqual(["a", "b", "c"]);
    expect(describePart("expenses", base.expenses, mine.expenses)).toBe("added Train");
  });
});

describe("amounts set per person", () => {
  it("splits what's left evenly among the others, and balances follow", async () => {
    const { partsOf, unassigned, balances } = await import("../shared/expenses");
    const e = { what: "Burgers", amount: 30, currency: "EUR", date: "2027-09-14", paidBy: "Mia", shares: { Tom: 12 } };
    expect(partsOf(e, ["Mia", "Tom", "Ann"])).toEqual({ Mia: 9, Tom: 12, Ann: 9 });
    expect(unassigned(e, ["Mia", "Tom", "Ann"])).toBe(0);
    expect(balances([e], ["Mia", "Tom", "Ann"], "EUR", {})).toEqual({ Mia: 21, Tom: -12, Ann: -9 });
    // Everyone set, but not to the amount: scaled to it, and said.
    const all = { ...e, split: ["Tom", "Ann"], shares: { Tom: 10, Ann: 10 } };
    expect(unassigned(all, ["Mia", "Tom", "Ann"])).toBe(10);
    expect(balances([all], ["Mia", "Tom", "Ann"], "EUR", {})).toEqual({ Mia: 30, Tom: -15, Ann: -15 });
  });
});
