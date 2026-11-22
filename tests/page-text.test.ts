// Reading pages for local models' research: structure kept, structured data read, long pages cut to what's asked for,
// PDFs read, and only addresses the model has seen get fetched.
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { UrlGuard } from "../server/research/fetch-page";
import { focusText, htmlToText, pdfText, structuredData } from "../server/research/page-text";

const PAGE = `<html><head><title>Castle Museum</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Museum","name":"Castle Museum",
"openingHoursSpecification":[{"dayOfWeek":["https://schema.org/Tuesday","Wednesday"],"opens":"09:00","closes":"17:00"}],
"address":{"streetAddress":"Burgweg 1","addressLocality":"Füssen"}},
{"@type":"Event","name":"Night tour","startDate":"2027-09-18T20:00","offers":{"price":"12","priceCurrency":"EUR"}}]}</script>
</head><body><nav><a href="/">Home</a> menu menu</nav>
<main><h1>Castle Museum</h1><p>The museum in the old castle &amp; its gardens tells the story of the town since the 12th century, with armour, paintings and the old kitchens. There is far more to see than one expects from a small town museum, and a visit takes about two hours.</p>
<h2>Prices</h2><table><tr><th>Ticket</th><th>Price</th></tr><tr><td>Adults</td><td>€9</td></tr><tr><td>Children</td><td>€4</td></tr></table>
<h2>Visit</h2><ul><li>Lockers at the entrance</li><li>No dogs</li></ul></main>
<footer>Impressum</footer></body></html>`;

describe("page text", () => {
  it("keeps headings, table rows and list items, without menus and footers", () => {
    const t = htmlToText(PAGE);
    expect(t).toContain("## Castle Museum");
    expect(t).toContain("### Prices");
    expect(t).toContain("Adults | €9");
    expect(t).toContain("- Lockers at the entrance");
    expect(t).toContain("old castle & its gardens");
    expect(t).not.toMatch(/menu menu|Impressum/);
  });

  it("reads opening hours, events and prices from structured data", () => {
    const facts = structuredData(PAGE).join("\n");
    expect(facts).toContain('Museum "Castle Museum": opening hours: Tuesday, Wednesday 09:00–17:00');
    expect(facts).toContain("address: Burgweg 1, Füssen");
    expect(facts).toMatch(/Event "Night tour": dates: 2027-09-18T20:00 · prices: 12 EUR/);
  });

  it("cuts a long page to its start and the parts that match what's asked for", () => {
    const filler = (n: number) => Array.from({ length: n }, (_, k) => `## Story ${k}\n${"Long history of the castle and its owners. ".repeat(12)}`).join("\n\n");
    const text = `## Castle\nWhat this place is.\n\n${filler(10)}\n\n## Opening hours\nTue–Sun 9:00–17:00, closed Mondays. In winter 10:00–16:00.\n\n${filler(10)}`;
    const out = focusText(text, "opening hours in September", 2500);
    expect(out.length).toBeLessThan(2900);
    expect(out.startsWith("## Castle")).toBe(true);
    expect(out).toContain("closed Mondays");
    expect(out).toContain("[…]");
    expect(focusText("short page", "anything")).toBe("short page");
  });
});

/** A one-page PDF whose page content is `content` (optionally compressed). */
function pdf(content: string, compress = false) {
  const data = compress ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1"),
    data, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

describe("PDF text", () => {
  const content = "BT /F1 12 Tf 72 720 Td (Timetable Fussen - Munich) Tj 0 -14 Td [(Departs 08:15, arrives 10:20) -250 (daily)] TJ T* (Fare: 30 EUR \\(adult\\)) Tj ET";
  it("reads the text of plain and compressed pages", () => {
    for (const compress of [false, true]) {
      const t = pdfText(pdf(content, compress));
      expect(t).toContain("Timetable Fussen - Munich");
      expect(t).toContain("Departs 08:15, arrives 10:20 daily");
      expect(t).toContain("Fare: 30 EUR (adult)");
    }
  });
  it("gives up on text it can't read", () => {
    expect(pdfText(pdf("BT (\x01\x02\x03\x04\x05\x06\x07\x08\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x01\x02\x03\x04\x05\x06\x07\x08\x0e\x0f\x10\x11\x12) Tj ET"))).toBe("");
  });
});

describe("only addresses the model has seen", () => {
  it("allows search results, links on pages read and other pages of those sites; refuses made-up ones", () => {
    const g = new UrlGuard();
    g.saw("Castle Museum\nhttps://www.castle-museum.de/en/visit\nThe museum in the castle.");
    g.saw("Links on this page:\nTickets: https://tickets.example.org/castle.");
    expect(g.allowed("https://www.castle-museum.de/en/visit/")).toBe(true);
    expect(g.allowed("https://castle-museum.de/en/opening-hours")).toBe(true); // same site
    expect(g.allowed("https://tickets.example.org/castle")).toBe(true);
    expect(g.allowed("https://castle-museum-fuessen.com/hours")).toBe(false);
  });
});
