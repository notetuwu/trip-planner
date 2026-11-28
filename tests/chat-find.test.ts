// The trip chat finding a booking's document or email: the trip's kept files searched by what they say, both only once
// a model elsewhere is allowed to, and the results to show picked from the reply.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The app's data folder is read when the server's modules load: a temporary one, set before any of them do.
await vi.hoisted(async () => {
  const [f, o, p] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  process.env.TRIP_PLANNER_DATA = f.mkdtempSync(p.join(o.tmpdir(), "tp-find-"));
});
const asked = vi.hoisted(() => ({ prompts: [] as string[], replies: [] as string[], mail: [] as string[] }));
vi.mock("../server/ai/ask", () => ({ askModel: async (_m: string, prompt: string) => { asked.prompts.push(prompt); return asked.replies.shift() || "Nothing."; } }));
vi.mock("../server/sync/google", async (original) => ({ ...(await original<object>()), gmailAccounts: () => [{ email: "me@example.com" }] }));
vi.mock("../server/sync/gmail", () => ({
  listMail: async (_a: string, o: { query: string }) => { asked.mail.push(o.query); return { mails: [{ id: "abc123def", subject: "Your ferry", from: "Example Ferries", date: "2027-05-01T10:00:00Z", snippet: "Ferry" }], next: "" }; },
  readMail: async () => ({ data: Buffer.from("Subject: Your ferry\n\nBooking code QX7, 2 June 09:00.").toString("base64") }),
}));

import { SAVES_DIR } from "../server/config";
import { type FindContext, excerpt, scoreDoc, searchDocs, searchWords, shownFound, withoutShow } from "../server/trip/chat-find";
import { askCompanion, cleanAnswer, searchLookups } from "../server/trip/companion";

beforeAll(() => {
  const docs = path.join(SAVES_DIR, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "confirmation.txt"), "Hôtel Exemple, Zürich: 3 nights, booking number AB12.");
  fs.writeFileSync(path.join(docs, "scan 4.txt"), "Boat to the island, adults 2.");
  fs.writeFileSync(path.join(docs, "photo.png"), "x");
});

describe("searching the trip's documents", () => {
  const ctx = (): FindContext => ({ trip: "Test", links: { "photo.png": "Museum tickets, 2027-06-03" }, found: [] });
  it("finds a file by what it says, without accents, and names it to show", async () => {
    const c = ctx(), out = await searchDocs("hotel zurich", c);
    expect(out).toContain("[doc1] confirmation.txt");
    expect(out).toContain("AB12");
    expect(shownFound("The hotel's.\nSHOW: doc1", c.found)).toEqual([{ kind: "doc", ref: "doc1", name: "confirmation.txt" }]);
  });
  it("finds a picture by the booking it's on, and lists what's kept when nothing matches", async () => {
    expect(await searchDocs("museum", ctx())).toContain("[doc1] photo.png (on the booking: Museum tickets, 2027-06-03)");
    const out = await searchDocs("submarine", ctx());
    expect(out).toContain("None has those words");
    expect(out).toContain("scan 4.txt");
  });
  it("says so for a trip that isn't saved", async () => {
    expect(await searchDocs("hotel", { trip: "", links: {}, found: [] })).toContain("isn't saved");
  });
  it("scores names above text and cuts long texts around the words", () => {
    expect(searchWords("Zürich, the HOTEL!")).toEqual(["zurich", "the", "hotel"]);
    expect(scoreDoc(["ferry"], "ferry.pdf", "", "").score).toBeGreaterThan(scoreDoc(["ferry"], "a.pdf", "", "ferry ferry").score);
    expect(excerpt(`${"start ".repeat(600)} needle here`, ["needle"])).toContain("needle");
  });
  it("shows every file the answer names, and lists all of them on request", async () => {
    const c = ctx(), out = await searchDocs("all", c);
    expect(out).toContain("All 3 kept");
    const reply = "There's confirmation.txt, scan 4.txt and photo.png.\nSHOW: doc1";
    expect(shownFound(reply, c.found).map((f) => (f.kind === "doc" ? f.name : "")).sort()).toEqual(["confirmation.txt", "photo.png", "scan 4.txt"]);
    const two = [{ kind: "doc" as const, ref: "doc1", name: "ticket.pdf" }, { kind: "doc" as const, ref: "doc2", name: "ferry ticket.pdf" }];
    expect(shownFound("Only the ferry ticket.pdf is there.", two)).toEqual([two[1]]);
    // An email with a few letters for a subject is in any sentence: shown only when the SHOW line names it.
    const hi = [{ kind: "mail" as const, ref: "mail1", account: "a@example.com", id: "1", subject: "Hi", from: "Sam", date: "2030-01-01" }];
    expect(shownFound("Nothing in this one.", hi)).toEqual([]);
    expect(shownFound("That's it.\nSHOW: mail1", hi)).toEqual(hi);
  });
  it("takes the SHOW line out of what's written, and leaves ordinary words alone", () => {
    expect(cleanAnswer("Here it is.\nSHOW: doc1, mail2")).toBe("Here it is.");
    expect(withoutShow("Show: 20:00 at the theatre")).toBe("Show: 20:00 at the theatre");
  });
});

describe("searching from the chat", () => {
  const req = { question: "Find the ferry email in my Gmail", trip: "Test", days: 0 };
  const reset = (...replies: string[]) => { asked.prompts = []; asked.mail = []; asked.replies = replies; };
  it("asks first when the model isn't on this computer, and searches nothing", async () => {
    reset("LOOKUP: gmail | {ferry traghetto}");
    const r: any = await askCompanion({ ...req, model: "api|anthropic|some-model" }, () => {});
    expect(r.searchAsk.searches).toEqual([{ kind: "gmail", args: ["{ferry traghetto}"] }]);
    expect(asked.mail).toEqual([]);
  });
  it("searches once allowed, and shows what the answer picked", async () => {
    reset("Your booking code is QX7.\nSHOW: mail1");
    const r: any = await askCompanion({ ...req, model: "api|anthropic|some-model", searches: [{ kind: "gmail", args: ["ferry"] }] }, () => {});
    expect(asked.mail).toEqual(["ferry"]);
    expect(asked.prompts[0]).toContain("QX7");
    expect(r.answer).toBe("Your booking code is QX7.");
    expect(r.found).toMatchObject([{ kind: "mail", id: "abc123def", account: "me@example.com" }]);
    expect(r.read).toBe(true);
  });
  it("searches straight away with a model on this computer", async () => {
    reset("LOOKUP: gmail | ferry", "Found it.\nSHOW: mail1");
    const r: any = await askCompanion({ ...req, model: "local|ollama|some-model" }, () => {});
    expect(r.searchAsk).toBeUndefined();
    expect(asked.mail).toEqual(["ferry"]);
    expect(r.found).toHaveLength(1);
  });
  it("asks before reading documents too, and allowing them doesn't allow the mail", async () => {
    reset("LOOKUP: docs | hotel");
    const first: any = await askCompanion({ ...req, model: "api|anthropic|some-model" }, () => {});
    expect(first.searchAsk.searches).toEqual([{ kind: "docs", args: ["hotel"] }]);
    expect(first.answer).toContain("the trip's documents");
    expect(asked.prompts).toHaveLength(1);
    reset("LOOKUP: gmail | hotel");
    const then: any = await askCompanion({ ...req, model: "api|anthropic|some-model", searches: first.searchAsk.searches }, () => {});
    expect(asked.prompts[0]).toContain("AB12");
    expect(then.searchAsk.searches.map((s: any) => s.kind)).toEqual(["docs", "gmail"]);
    expect(asked.mail).toEqual([]);
  });
  it("doesn't ask when there's nothing to read (a trip that isn't saved)", async () => {
    reset("LOOKUP: docs | hotel", "Save the trip first.");
    const r: any = await askCompanion({ ...req, trip: "", model: "api|anthropic|some-model" }, () => {});
    expect(r.searchAsk).toBeUndefined();
    expect(r.answer).toBe("Save the trip first.");
  });
  it("only runs document and mail searches sent back with permission", () => {
    expect(searchLookups([{ kind: "search", args: ["x"] }, { kind: "gmail", args: ["ferry", 3] }, null])).toEqual([{ kind: "gmail", args: ["ferry"] }]);
  });
});
