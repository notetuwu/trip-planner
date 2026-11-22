// The update check asks GitHub sparingly: the answer is kept, a refusal (rate limit) is waited out without falling
// back to github.com pages, and Check now asks at most once a minute.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/config", async (orig) => ({ ...(await orig<typeof import("../server/config")>()), PACKAGED: true, VERSION: "3.0.0" }));

const release = { tag_name: "v3.1.0", html_url: "https://example.test/r", assets: [] };
let calls: string[] = [];
let reply: () => Response;

beforeEach(() => {
  vi.resetModules();
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-upd-"));
  delete process.env.TRIP_PLANNER_NO_UPDATES;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return reply(); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const load = () => import("../server/update/check");

describe("update check", () => {
  it("keeps the answer instead of asking again", async () => {
    reply = () => new Response(JSON.stringify(release), { headers: { etag: '"a"' } });
    const { checkForUpdate } = await load();
    expect((await checkForUpdate())?.newer).toBe(true);
    await checkForUpdate();
    await checkForUpdate();
    expect(calls).toHaveLength(1);
  });

  it("waits out a refusal and never loads github.com pages", async () => {
    reply = () => new Response("", { status: 403, headers: { "retry-after": "600" } });
    const { checkForUpdate, updateState } = await load();
    await expect(checkForUpdate()).rejects.toThrow(/wait/);
    expect(calls.every((u) => u.includes("api.github.com"))).toBe(true);
    await checkForUpdate(true);
    await checkForUpdate();
    expect(calls).toHaveLength(1);
    expect(updateState().waitUntil).toBeGreaterThan(Date.now() + 500e3);
  });

  it("Check now asks again, but at most once a minute, and sends the ETag", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    reply = () => new Response(JSON.stringify(release), { headers: { etag: '"a"' } });
    const { checkForUpdate } = await load();
    await checkForUpdate(true);
    await checkForUpdate(true);
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61e3);
    reply = () => new Response(null, { status: 304 });
    expect((await checkForUpdate(true))?.latest).toBe("3.1.0");
    expect(calls).toHaveLength(2);
    const sent = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1][1].headers as Record<string, string>;
    expect(sent["If-None-Match"]).toBe('"a"');
  });

  it("asks nothing by itself when the automatic check is off", async () => {
    reply = () => new Response(JSON.stringify(release));
    (await import("../server/settings")).writeSettings({ checkUpdates: false });
    const { checkForUpdate } = await load();
    expect(await checkForUpdate()).toBeNull();
    expect(calls).toHaveLength(0);
    await checkForUpdate(true);
    expect(calls).toHaveLength(1);
  });
});
