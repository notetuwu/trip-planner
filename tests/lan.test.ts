// Phone access: the gate in front of the planner on the home network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let lanGate: typeof import("../server/lan").lanGate, lanToken: typeof import("../server/settings").lanToken;
let refuse: typeof import("../server/util/guard").refuse;
beforeAll(async () => {
  // Settings (and the link's secret) in a folder of their own, not the planner's real data.
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-lan-"));
  ({ lanGate } = await import("../server/lan"));
  ({ lanToken } = await import("../server/settings"));
  ({ refuse } = await import("../server/util/guard"));
});

/** Runs a request through the gate: what it answered, and whether the app got it. */
function ask(url: string, cookie = "") {
  const req: any = { url, method: "GET", headers: { host: "192.168.1.20:47616", ...(cookie ? { cookie } : {}) } };
  const out = { status: 0, headers: {} as Record<string, string>, body: "", handled: false, lan: false };
  const res: any = {
    writeHead(s: number, h: Record<string, string> = {}) { out.status = s; out.headers = h; return res; },
    end(b = "") { out.body = String(b); },
  };
  lanGate((r: any) => { out.handled = true; out.lan = !!r.lan; })(req, res);
  return out;
}

describe("phone access on the home network", () => {
  it("turns away anyone without the link", () => {
    const r = ask("/");
    expect(r.status).toBe(401);
    expect(r.handled).toBe(false);
    expect(ask("/api/saves").status).toBe(401);
    expect(ask("/", "tp_lan=wrong").status).toBe(401);
  });
  it("lets the link in once and remembers it in a cookie", () => {
    const token = lanToken();
    const r = ask(`/?t=${token}`);
    expect(r.status).toBe(302);
    expect(r.headers.Location).toBe("/");
    expect(r.headers["Set-Cookie"]).toMatch(new RegExp(`^tp_lan=${token}; .*HttpOnly; SameSite=Strict`));
    const page = ask("/", `tp_lan=${token}`);
    expect(page.handled).toBe(true);
    expect(page.lan).toBe(true);
    expect(ask("/api/saves", `other=1; tp_lan=${token}`).handled).toBe(true);
  });
  it("keeps keys, updates, settings and model downloads on the computer", () => {
    const c = `tp_lan=${lanToken()}`;
    for (const p of ["/api/keys/anthropic", "/api/update/install", "/api/settings", "/api/lan", "/api/ollama/pull", "/api/open"]) {
      const r = ask(p, c);
      expect([p, r.status, r.handled]).toEqual([p, 403, false]);
    }
  });
  it("the API accepts a phone's own pages but not other sites", () => {
    const phone = (origin?: string): any => ({ lan: true, method: "POST", headers: { host: "192.168.1.20:47616", ...(origin ? { origin } : {}) } });
    expect(refuse(phone())).toBeNull();
    expect(refuse(phone("http://192.168.1.20:47616"))).toBeNull();
    expect(refuse(phone("https://evil.example"))).toMatch(/other sites/);
    // Without the gate's mark, a home-network address is still refused (the normal server only answers localhost).
    expect(refuse({ method: "GET", headers: { host: "192.168.1.20:47615" } } as any)).toMatch(/localhost/);
  });
});
