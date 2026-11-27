// Gmail for booking emails: a connected account's inbox, booking emails or a search, page by page, and one email as
// text and as a .eml file; and the sign-ins, one per account, apart from Drive's.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const root = await vi.hoisted(async () => {
  const [f, o, p] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  return (process.env.TRIP_PLANNER_DATA = f.mkdtempSync(p.join(o.tmpdir(), "tp-gmail-")));
});

const google = await import("../server/sync/google");
const { BOOKINGS, listMail, readMail, safeEmailHtml } = await import("../server/sync/gmail");

const ME = "one@example.com", OTHER = "two@example.com";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
let asked: { url: string; method: string; auth: string }[] = [];
let answer: (url: string) => { status?: number; body: unknown };

describe("Gmail", () => {
  beforeEach(() => {
    asked = [];
    fs.mkdirSync(path.join(root, "sync"), { recursive: true });
    fs.writeFileSync(path.join(root, "sync", "google-client.json"), JSON.stringify({ id: "1-x.apps.googleusercontent.com", secret: "GOCSPX-test" }));
    fs.writeFileSync(path.join(root, "sync", "gmail-auth.json"), JSON.stringify({ accounts: [{ email: ME, refresh: "r1" }, { email: OTHER, refresh: "r2" }] }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        const refresh = new URLSearchParams(String(init.body)).get("refresh_token");
        return refresh === "r2" ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : new Response(JSON.stringify({ access_token: `t-${refresh}`, expires_in: 3600 }));
      }
      asked.push({ url, method: init.method || "GET", auth: String((init.headers as Record<string, string>)?.Authorization || "") });
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status || 200 });
    }));
  });

  it("lists the inbox, the booking emails or a search, page by page, only ever reading", async () => {
    answer = (url) => url.includes("/messages?")
      ? { body: { messages: [{ id: "abc123def" }], nextPageToken: "p2" } }
      : { body: { internalDate: "1820000000000", snippet: "Your table &amp; time", payload: { headers: [{ name: "Subject", value: "Your table" }, { name: "From", value: '"Caffè Pedrocchi" <book@example.com>' }] } } };
    const r = await listMail(ME);
    const list = () => new URL(asked.find((a) => a.url.includes("/messages?"))!.url).searchParams;
    expect(list().get("labelIds")).toBe("INBOX");
    expect(r.next).toBe("p2");
    expect(r.mails[0]).toMatchObject({ subject: "Your table", from: "Caffè Pedrocchi", fromEmail: "book@example.com", snippet: "Your table & time" });
    asked = [];
    await listMail(ME, { view: "bookings", page: "p2" });
    expect([list().get("q"), list().get("pageToken")]).toEqual([BOOKINGS, "p2"]);
    asked = [];
    await listMail(ME, { query: "from:pedrocchi", view: "bookings" });
    expect(list().get("q")).toBe("from:pedrocchi");
    expect(asked.every((a) => a.method === "GET" && a.auth === "Bearer t-r1")).toBe(true);
  });

  it("opens a text email as HTML with its links, with its .eml file", async () => {
    answer = () => ({ body: { raw: b64("Subject: Table: 14/09\r\nFrom: Pedrocchi <book@example.com>\r\n\r\nSee you at 20:00 <3. https://example.com/b") } });
    const m = await readMail(ME, "abc123def");
    expect(m).toMatchObject({ name: "Table 14 09.eml", subject: "Table: 14/09", from: "Pedrocchi", fromEmail: "book@example.com", remote: false, attachments: [] });
    expect(m.html).toBe('<pre class="plain">See you at 20:00 &#60;3. <a href="https://example.com/b">https://example.com/b</a></pre>');
    expect(Buffer.from(m.data, "base64").toString()).toContain("See you at 20:00 <3.");
    await expect(readMail(ME, "../profile")).rejects.toThrow(/No such email/);
  });

  it("keeps each account's sign-in apart: one signed out by Google doesn't stop the other, and removing one leaves the rest", async () => {
    answer = () => ({ body: { messages: [] } });
    await expect(listMail(OTHER)).rejects.toThrow(/signed two@example\.com out/);
    expect(google.gmailAccounts()).toEqual([{ email: ME }, { email: OTHER, expired: true }]);
    await listMail(ME);
    await expect(listMail("nobody@example.com")).rejects.toThrow(/Connect Gmail first/);
    await google.gmailSignOut(OTHER);
    expect(google.gmailAccounts()).toEqual([{ email: ME }]);
  });

  it("makes an email's HTML safe to show: no scripts, frames, refreshes or handlers; its own pictures in; web pictures noticed", () => {
    const s = safeEmailHtml(`<meta http-equiv="refresh" content="0;url=https://x"><script>alert(1)</script><iframe src="https://x"></iframe>
      <a href="javascript:alert(1)" onclick="x()">a</a><img src="cid:logo@1" onerror="x()"><form action="https://x"><input name=p></form><p style="color:red">Hi</p>`, { "logo@1": "data:image/png;base64,AAAA" });
    expect(s.html).not.toMatch(/script|iframe|refresh|onclick|onerror|javascript|<form|<input|action=/i);
    expect(s.html).toContain('<img src="data:image/png;base64,AAAA">');
    expect(s.html).toContain('<p style="color:red">Hi</p>');
    expect(s.remote).toBe(false);
    expect(safeEmailHtml('<img src="https://track.example/x.png">').remote).toBe(true);
    expect(safeEmailHtml('<td style="background:url(//cdn.example/b.png)">').remote).toBe(true);
  });

  it("says when the Gmail API is off", async () => {
    answer = () => ({ status: 403, body: { error: { message: "Gmail API has not been used in project 1 before or it is disabled." } } });
    await expect(listMail(ME)).rejects.toThrow(/Gmail API isn't switched on/);
  });
});
