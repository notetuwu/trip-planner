// How a transfer goes, from its tag, its transport text or (for a transfer) its own name: a taxi or an Uber is by road,
// so the map routes it along the roads instead of looking for a train that isn't there.
import { describe, expect, it } from "vitest";
import { modeOf } from "../web/src/trip/mode-of";

const stop = (place: string, transport = "", kind: any = "transfer") => ({ place, transport, kind, time: "", description: "" });

describe("a transfer's mode", () => {
  it("knows taxis and ride services, also from the stop's name", () => {
    expect(modeOf(stop("Uber Odawara → Maple Stay Hotel, Route 1 Hakone"))).toBe("car");
    expect(modeOf(stop("Taxi to the JR station"))).toBe("car");
    expect(modeOf(stop("To the hotel", "Pre-booked taxi, about 40 min"))).toBe("car");
  });
  it("still reads trains from the name, and leaves other stops' names alone", () => {
    expect(modeOf(stop("Shinkansen Shin-Osaka to Odawara"))).toBe("train");
    expect(modeOf(stop("Check out & Osaka Metro to Shin-Osaka"))).toBe("train");
    expect(modeOf(stop("Uber Eats dinner", "", "meal"))).toBe("");
  });
});
