// The travelers' interests, wishes and notes read into what code acts on: diets for the restaurant lists, allergies
// and things to avoid for the planner, kinds of place asked for, and famous sights or hidden gems.
import { describe, expect, it } from "vitest";
import { cleanPrefs, NO_PREFS, placeMixOf, prefsFromWords, prefsLines, prefsPrompt, readPrefs, WANT_KINDS } from "../server/trip/prefs";

describe("preferences from the words alone (no model)", () => {
  it("recognises diets in several languages", () => {
    expect(prefsFromWords("make sure to get restaurants with vegetarian options").diet).toEqual(["vegetarian"]);
    expect(prefsFromWords("wir essen vegan und glutenfrei").diet).toEqual(["vegan", "gluten_free"]);
    expect(prefsFromWords("cucina vegetariana, senza lattosio").diet).toEqual(["vegetarian", "lactose_free"]);
    expect(prefsFromWords("nous mangeons halal").diet).toEqual(["halal"]);
    expect(prefsFromWords("we love food markets").diet).toEqual([]);
  });
  it("reads a wish for hidden gems or the famous sights", () => {
    expect(prefsFromWords("hidden gems locals love, no tourist traps").placeMix).toBe("hidden");
    expect(prefsFromWords("the big must-sees plus hidden gems").placeMix).toBe("mixed");
    expect(prefsFromWords("take me anywhere").placeMix).toBeUndefined();
  });
});

describe("what the model returns", () => {
  it("keeps only what the schema allows", () => {
    const p = cleanPrefs({ diet: ["vegan", "paleo", "vegan"], allergies: ["nuts", "", 7], avoid: ["crowds"], wants: [{ kind: "lighthouse", what: "a lighthouse", where: null }, { kind: "spaceport", what: "x" }, { kind: "thermal_bath", what: "thermal baths", where: "Budapest" }], placeMix: "hidden" });
    expect(p).toEqual({ diet: ["vegan"], allergies: ["nuts"], avoid: ["crowds"], wants: [{ kind: "lighthouse", what: "a lighthouse" }, { kind: "thermal_bath", what: "thermal baths", where: "Budapest" }], placeMix: "hidden" });
    expect(cleanPrefs(null)).toEqual(NO_PREFS);
    expect(cleanPrefs({ placeMix: "whatever" }).placeMix).toBeUndefined();
  });
  it("every kind asked for has OpenStreetMap filters", () => {
    for (const [k, v] of Object.entries(WANT_KINDS)) {
      expect(v.filters.length, k).toBeGreaterThan(0);
      for (const f of v.filters) expect(f, k).toMatch(/^(\[[^\]]+\])+$/);
    }
    expect(prefsPrompt("x")).toContain("lighthouse");
  });
  it("asks the model once per text, and keeps what the words said for sure", async () => {
    const asked: string[] = [];
    const ask = async (_model: string, prompt: string) => { asked.push(prompt); return JSON.stringify({ diet: [], allergies: ["shellfish"], avoid: [], wants: [{ kind: "lighthouse", what: "un faro", where: null }], placeMix: null }); };
    const store = { data: {}, save() {} }; // not the disk cache
    const trip = { interests: "vegetarisch, Schalentier-Allergie", wishes: "vorrei vedere un faro", model: "local|ollama|http://x|m" };
    const p = await readPrefs(trip, ask as any, undefined, store);
    expect(p.diet).toEqual(["vegetarian"]); // the words knew it, the model missed it
    expect(p.allergies).toEqual(["shellfish"]);
    expect(p.wants).toEqual([{ kind: "lighthouse", what: "un faro" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("vorrei vedere un faro");
    await readPrefs(trip, ask as any, undefined, store);
    expect(asked).toHaveLength(1); // cached by the text
  });
  it("falls back to the words when the model fails, and asks nothing without a model or text", async () => {
    const failing = async () => { throw new Error("down"); };
    expect((await readPrefs({ interests: "vegan", model: "local|ollama|http://x|m" }, failing as any, undefined, { data: {}, save() {} })).diet).toEqual(["vegan"]);
    let asked = 0;
    const counting = async () => { asked++; return "{}"; };
    expect(await readPrefs({ interests: "vegan" }, counting as any)).toMatchObject({ diet: ["vegan"] });
    expect(await readPrefs({ interests: "  ", model: "x" }, counting as any)).toEqual(NO_PREFS);
    expect(asked).toBe(0);
  });
});

describe("what the planner is told", () => {
  it("writes diets, allergies, avoidances and wishes as rules", () => {
    const lines = prefsLines({ diet: ["vegan", "gluten_free"], allergies: ["nuts"], avoid: ["long hikes"], wants: [{ kind: "lighthouse", what: "a lighthouse", where: "the coast" }] });
    expect(lines).toMatch(/vegan and gluten-free diet/);
    expect(lines).toMatch(/Allergies: nuts/);
    expect(lines).toMatch(/rather not: long hikes/);
    expect(lines).toMatch(/asked to see: a lighthouse \(the coast\)/);
    expect(prefsLines(NO_PREFS)).toBe("");
    expect(prefsLines(undefined)).toBe("");
  });
  it("the trip's own setting wins over the wishes, and a mix is the default", () => {
    expect(placeMixOf({ placeMix: "popular", prefs: { ...NO_PREFS, placeMix: "hidden" } })).toBe("popular");
    expect(placeMixOf({ placeMix: "", prefs: { ...NO_PREFS, placeMix: "hidden" } })).toBe("hidden");
    expect(placeMixOf({})).toBe("mixed");
  });
});
