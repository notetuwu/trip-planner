import { describe, expect, it } from "vitest";
import { checkHours } from "../server/trip/hours";

// 2026-03-02 is a Monday, 2026-03-01 a Sunday.
const base = { hours: "Mo-Fr 09:00-17:00", lat: 48.1, lng: 11.6, cc: "", minutes: 60 };

describe("opening hours", () => {
  it("is fine while open", () => {
    expect(checkHours({ ...base, date: "2026-03-02", time: "10:00" }).status).toBe("ok");
  });
  it("spots days it's closed", () => {
    const r = checkHours({ ...base, date: "2026-03-01", time: "10:00" });
    expect(r.status).toBe("closed-all-day");
    expect(r.text).toContain("Sunday");
    expect(checkHours({ ...base, hours: "Tu-Su 10:00-18:00", date: "2026-03-02", time: "" }).status).toBe("closed-all-day");
  });
  it("spots arriving early and staying past closing", () => {
    expect(checkHours({ ...base, date: "2026-03-02", time: "08:30" })).toMatchObject({ status: "opens-later", text: expect.stringContaining("09:00") });
    expect(checkHours({ ...base, date: "2026-03-02", time: "16:30" })).toMatchObject({ status: "closes-early", text: expect.stringContaining("17:00") });
    expect(checkHours({ ...base, date: "2026-03-02", time: "19:00" }).status).toBe("closed");
  });
  it("knows public holidays when the country is given", () => {
    // 2026-12-25 (Friday) is Christmas in Germany.
    expect(checkHours({ ...base, hours: "Mo-Fr 09:00-17:00; PH off", cc: "DE", date: "2026-12-25", time: "10:00" }).status).toBe("closed-all-day");
  });
  it("gives up quietly on hours it can't read", () => {
    expect(checkHours({ ...base, hours: "by appointment, call ahead", date: "2026-03-02", time: "10:00" }).status).toBe("unknown");
  });
});
