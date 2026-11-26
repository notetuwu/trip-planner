// The chat's suggested places become map links even when the model writes them as plain names.
import { describe, expect, it } from "vitest";
import { asksForPlaces, linkSuggested, townOf, withEverySuggestion } from "../server/trip/chat-places";

describe("linkSuggested", () => {
  it("links the name each suggestion starts with, in the town talked about", () => {
    const reply = "Options in Soprabolzano:\n\n- **Zum Muster** (4.6/5): vegetarian mains\n2. **Restaurant 1908 (Parkhotel Holzner)**: refined\n- **Tip:** book ahead";
    expect(linkSuggested(reply, [], "Soprabolzano")).toBe("Options in Soprabolzano:\n\n- **[Zum Muster](map:Zum Muster, Soprabolzano)** (4.6/5): vegetarian mains\n2. **[Restaurant 1908 (Parkhotel Holzner)](map:Restaurant 1908 Parkhotel Holzner, Soprabolzano)**: refined\n- **Tip:** book ahead");
  });

  it("links the places offered to pick from where they're only mentioned, once", () => {
    expect(linkSuggested("Try Gasthaus Babsi or Puro. Puro is quieter.", ["Gasthaus Babsi", "Puro"], ""))
      .toBe("Try [Gasthaus Babsi](map:Gasthaus Babsi) or [Puro](map:Puro). Puro is quieter.");
  });

  it("leaves a reply that has its links alone", () => {
    const reply = "- **[Zum Muster](map:Zum Muster, Bozen)**: good";
    expect(linkSuggested(reply, ["Zum Muster"], "Bozen")).toBe(reply);
  });
});

describe("townOf", () => {
  it("takes the town the words are about, else one of the trip's they name", () => {
    expect(townOf(["Here are the best options in **Soprabolzano**:"], ["Verona"])).toBe("Soprabolzano");
    expect(townOf(["find restaurants", "Lunch before leaving Verona"], ["Verona"])).toBe("Verona");
    expect(townOf(["find restaurants in Day 14"], [])).toBe("");
  });

  it("knows a question about places from one about the plan", () => {
    expect(asksForPlaces("find restaurants with vegetarian options")).toBe(true);
    expect(asksForPlaces("swap days 3 and 4")).toBe(false);
  });
});

describe("withEverySuggestion", () => {
  const reply = ["Gasthaus Probst", "Gasthaus Beispiel", "Green Bio Bistro", "Wrapz"].map((n) => `- **[${n}](map:${n}, Bozen)**: good`).join("\n");

  it("adds a listed place the question left out, before the answers that aren't places", () => {
    expect(withEverySuggestion(["Green Bio Bistro (Bolzano)", "Wrapz (Bolzano)", "Gasthaus Probst (Cornedo)", "Keep Musterhof"], reply))
      .toEqual(["Green Bio Bistro (Bolzano)", "Wrapz (Bolzano)", "Gasthaus Probst (Cornedo)", "Gasthaus Beispiel", "Keep Musterhof"]);
  });

  it("leaves a question that isn't about which place as it was asked", () => {
    expect(withEverySuggestion(["Lunch", "Dinner"], reply)).toEqual(["Lunch", "Dinner"]);
  });
});
