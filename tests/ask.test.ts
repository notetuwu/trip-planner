// The one-off model helper with a stand-in Ollama server: a model that goes round in circles is stopped and asked
// again (more directly), and one that keeps looping ends with an error instead of spinning until the timeout.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askModel } from "../server/ai/ask";

const round = "Let me check the route once more. The castle is on the way from the lake to the mountains, so it goes in onTheWay. "
  + "The fortress gets a stay in its town. The nights add up. This is consistent, so I will output the JSON now. ";
let server: http.Server, base = "", loopsLeft = 0;
const bodies: any[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      // The model's details (its context length): none, like an older Ollama.
      if (req.url === "/api/show") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const send = (o: object) => res.write(`${JSON.stringify(o)}\n`);
      if (loopsLeft-- > 0) {
        // Thinks the same round over and over (until the client hangs up).
        let n = 0;
        const t = setInterval(() => { if (res.destroyed || n++ > 400) { clearInterval(t); res.end(); } else send({ message: { thinking: round } }); }, 2);
        res.on("close", () => clearInterval(t));
        return;
      }
      send({ message: { content: '{"stays": [' } });
      send({ message: { content: '{"city": "Salzburg"}]}' } });
      send({ done: true, done_reason: "stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

describe("asking a model that goes round in circles", () => {
  it("stops it and asks once more, more directly", async () => {
    loopsLeft = 1; bodies.length = 0;
    const retries: string[] = [];
    const reply = await askModel(`local|ollama|${base}|test`, "Plan it.", () => {}, { onRetry: (m) => retries.push(m) });
    expect(reply).toBe('{"stays": [{"city": "Salzburg"}]}');
    expect(retries).toHaveLength(1);
    const second = bodies.at(-1);
    expect(second.messages[0].content).toMatch(/Answer with the JSON right away/);
    expect(second.options).toMatchObject({ temperature: 0.7, repeat_penalty: 1.15 });
  });
  it("gives up with a clear error when it loops again", async () => {
    loopsLeft = 2; bodies.length = 0;
    await expect(askModel(`local|ollama|${base}|test`, "Plan it.")).rejects.toThrow(/round in circles/);
  });
});
