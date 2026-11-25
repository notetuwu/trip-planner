// The person's own Google client (Settings → Sync): what's accepted when pasted, and that the secret stays on disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let g: typeof import("../server/sync/google");
let root = "";
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-gclient-"));
  process.env.TRIP_PLANNER_DATA = root;
  delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
  g = await import("../server/sync/google");
});

const ID = "1234567890-abcdefg.apps.googleusercontent.com", SECRET = "GOCSPX-abcdefghij1234567890";

describe("the Google client", () => {
  it("takes the ID and secret, or the downloaded JSON file", () => {
    expect(g.parseClient(` ${ID} `, SECRET)).toEqual({ id: ID, secret: SECRET });
    expect(g.parseClient(JSON.stringify({ installed: { client_id: ID, client_secret: SECRET } }), "")).toEqual({ id: ID, secret: SECRET });
  });

  it("says what's wrong with other things", () => {
    expect(() => g.parseClient("AIzaSyAbcdefghijklmnop", SECRET)).toThrow(/API key/);
    expect(() => g.parseClient("1234567890", SECRET)).toThrow(/apps\.googleusercontent\.com/);
    expect(() => g.parseClient(ID, "")).toThrow(/secret/);
    expect(() => g.parseClient(JSON.stringify({ web: { client_id: ID, client_secret: SECRET } }), "")).toThrow(/Desktop app/);
  });

  it("ships with none; saves what's entered, shows only the ID, and removes it again", async () => {
    expect(g.client()).toBeNull();
    await g.setClient({ id: ID, secret: SECRET });
    expect(g.client()).toEqual({ id: ID, secret: SECRET });
    expect(g.clientInfo()).toEqual({ clientFrom: "app", clientId: ID });
    expect(JSON.stringify(g.clientInfo())).not.toContain(SECRET);
    await g.setClient(null);
    expect(g.client()).toBeNull();
  });
});
