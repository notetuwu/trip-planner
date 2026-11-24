// The open trip shared by every window: a window that hasn't seen the latest copy can't overwrite it (a tab left open from
// earlier saving its old trip over a newer one), and one that has, can.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trip-current-"));
vi.mock("../server/config", () => ({ ROOT: root }));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

class FakeRes extends Writable {
  status = 0; text = "";
  writeHead(s: number) { this.status = s; return this; }
  _write(c: Buffer, _e: string, cb: () => void) { this.text += c.toString(); cb(); }
  get json() { return JSON.parse(this.text); }
}
const call = async (method: string, url: string, body?: object) => {
  const { handleCurrent } = await import("../server/routes/current");
  const req: any = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url });
  const res = new FakeRes();
  await handleCurrent(req, res as never);
  await new Promise((r) => res.end(r));
  return res.json;
};

describe("the open trip", () => {
  beforeAll(() => { fs.mkdirSync(root, { recursive: true }); });

  it("takes the first copy, and a window that has seen it can replace it", async () => {
    expect(await call("PUT", "/api/current", { at: 1000, base: 0, state: { n: 1 } })).toEqual({ at: 1000 });
    expect(await call("PUT", "/api/current", { at: 2000, base: 1000, state: { n: 2 } })).toEqual({ at: 2000 });
    expect((await call("GET", "/api/current?since=0")).state).toEqual({ n: 2 });
  });

  it("refuses a window that hasn't seen the latest copy, even though its own time is later, and keeps the newer trip", async () => {
    // A tab from earlier: last in step at 1000, saving at 9000.
    const r = await call("PUT", "/api/current", { at: 9000, base: 1000, state: { n: "old trip" } });
    expect(r).toEqual({ conflict: true, at: 2000 });
    const got = await call("GET", "/api/current?since=1000");
    expect(got).toEqual({ at: 2000, state: { n: 2 } });
  });

  it("refuses a page that doesn't say what it has seen (a tab left open from before this rule), once there's a copy", async () => {
    expect(await call("PUT", "/api/current", { at: 9500, state: { n: "blind" } })).toEqual({ conflict: true, at: 2000 });
    expect((await call("GET", "/api/current?since=0")).state).toEqual({ n: 2 });
  });
});
