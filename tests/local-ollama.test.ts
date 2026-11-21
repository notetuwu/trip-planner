import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planWithOllama } from "../server/ai/local-ollama";
import { localOutput } from "../server/ai/local-output";

// A fake Ollama: a thinking model that runs out of room while thinking, unless thinking is off.
const chats: any[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities: ["thinking"], model_info: { "fake.context_length": 262144 } }));
    const b = JSON.parse(body); chats.push(b);
    const line = (o: object) => res.write(JSON.stringify(o) + "\n");
    if (b.think) { line({ message: { thinking: "hmm " } }); line({ done: true, done_reason: "length", eval_count: 5 }); }
    else { line({ message: { content: '{"summary":"ok","days":[]}' } }); line({ done: true, done_reason: "stop", eval_count: 9 }); }
    res.end();
  });
});
let base = "";
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); })));
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("running out of context with Ollama", () => {
  it("retries once with twice the room and thinking off", async () => {
    const events: any[] = [];
    const output = localOutput((e) => events.push(e));
    const trip: any = { stays: [{ city: "A", nights: 2 }] };
    await planWithOllama({ base, model: "fake", prompt: "x".repeat(3000), trip, abort: new AbortController().signal, onEvent: (e) => events.push(e), output });
    expect(chats).toHaveLength(2);
    expect(chats[0].think).toBe(true);
    expect(chats[1].think).toBe(false);
    expect(chats[1].options.num_ctx).toBe(chats[0].options.num_ctx * 2);
    expect(output.out.content).toBe('{"summary":"ok","days":[]}');
    expect(events.some((e) => e.type === "status" && /ran out of room/.test(e.text))).toBe(true);
  });
});
