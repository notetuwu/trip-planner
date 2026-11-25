// Dropbox for sync, against a pretend Dropbox API: the sign-in is renewed with the app key alone (PKCE, no secret), folders
// are listed page by page, a trip file is written as a new file or over the version it was read as, a deleted one is
// told apart, and shared links and shared folders not yet in the Dropbox are handled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let box: typeof import("../server/sync/dropbox");
let store: typeof import("../server/sync/store");
let root = "";
const calls: { url: string; body: any; headers: Record<string, string> }[] = [];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-dropbox-"));
  process.env.TRIP_PLANNER_DATA = root;
  delete process.env.DROPBOX_APP_KEY;
  box = await import("../server/sync/dropbox");
  store = await import("../server/sync/store");
  await box.setAppKey("abc123def456");
  fs.writeFileSync(path.join(root, "sync", "dropbox-auth.json"), JSON.stringify({ refresh: "R1", email: "me@example.com", name: "Me", accountId: "dbid:1", at: 1 }));
});
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; });

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
/** A pretend Dropbox: answers by endpoint. */
function fake(answers: Record<string, (body: any, headers: Record<string, string>) => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = String(url), headers = Object.fromEntries(Object.entries((init.headers || {}) as Record<string, string>));
    let body: any = init.body;
    if (u.endsWith("/oauth2/token")) body = Object.fromEntries(new URLSearchParams(String(init.body)));
    else if (typeof init.body === "string" && headers["Content-Type"] === "application/json") body = JSON.parse(init.body);
    calls.push({ url: u, body, headers });
    // (The sign-in is renewed whenever Dropbox says it's out of date: always answered.)
    const all: Record<string, (body: any, headers: Record<string, string>) => Response> = { "/oauth2/token": token, ...answers };
    const key = Object.keys(all).find((k) => u.endsWith(k));
    if (!key) throw new Error(`Unexpected call: ${u}`);
    return all[key](body, headers);
  }));
}
const token = () => json({ access_token: "A1", expires_in: 14400 });

describe("Dropbox", () => {
  it("renews the sign-in with the app key alone, and lists a folder's trip files page by page", async () => {
    fake({
      "/oauth2/token": token,
      "/2/files/list_folder": () => json({ entries: [{ ".tag": "file", id: "id:aaaaaaa1", name: "Kyoto.trip.json", content_hash: "h1", server_modified: "2026-11-25T10:00:00Z", size: 10 }, { ".tag": "folder", id: "id:bbbbbbb1", name: "Photos" }], has_more: true, cursor: "C1" }),
      "/2/files/list_folder/continue": () => json({ entries: [{ ".tag": "file", id: "id:aaaaaaa2", name: "notes.txt", content_hash: "h2" }, { ".tag": "file", id: "id:aaaaaaa3", name: "Osaka.json", content_hash: "h3", sharing_info: { read_only: true } }], has_more: false }),
    });
    const files = await store.listTripFiles("dropbox:id:folder01");
    expect(files.map((f) => [f.id, f.name, f.md5Checksum, f.capabilities?.canEdit])).toEqual([
      ["dropbox:id:aaaaaaa1", "Kyoto.trip.json", "h1", true], ["dropbox:id:aaaaaaa3", "Osaka.json", "h3", false],
    ]);
    const t = calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(t.body).toEqual({ grant_type: "refresh_token", refresh_token: "R1", client_id: "abc123def456" });
    expect(calls.find((c) => c.url.endsWith("/list_folder"))!.headers.Authorization).toBe("Bearer A1");
  });

  it("writes a new trip file into the folder, and a changed one only over the version it was read as", async () => {
    fake({
      "/2/files/get_metadata": () => json({ ".tag": "file", id: "id:aaaaaaa1", name: "Kyoto.trip.json", path_lower: "/trips/kyoto.trip.json", rev: "015f" }),
      "/2/files/upload": (_b, h) => json({ ".tag": "file", id: "id:aaaaaaa1", name: "Kyoto.trip.json", content_hash: "h9", rev: "0160", _arg: h["Dropbox-API-Arg"] }),
    });
    await store.upload({ folder: "dropbox:id:folder01", name: "Kyōto.trip.json", text: "{}" });
    const first = JSON.parse(calls.find((c) => c.url.endsWith("/files/upload"))!.headers["Dropbox-API-Arg"]);
    expect(first).toEqual({ path: "id:folder01/Kyōto.trip.json", mode: "add", autorename: true, mute: true });
    // (Non-ASCII is escaped in the header, as Dropbox asks.)
    expect(calls.find((c) => c.url.endsWith("/files/upload"))!.headers["Dropbox-API-Arg"]).toContain("\\u014d");
    calls.length = 0;
    const up = await store.upload({ id: "dropbox:id:aaaaaaa1", name: "Kyoto.trip.json", text: "{}" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/files/upload"))!.headers["Dropbox-API-Arg"])).toEqual({ path: "/trips/kyoto.trip.json", mode: { ".tag": "update", update: "015f" }, autorename: false, mute: true });
    expect(up.md5Checksum).toBe("h9");
  });

  it("tells a deleted file apart, and explains a missing permission", async () => {
    fake({ "/2/files/get_metadata": () => json({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, 409) });
    expect(await store.fileMeta("dropbox:id:gone0001")).toMatchObject({ trashed: true });
    fake({ "/2/files/list_folder": () => json({ error_summary: "missing_scope/..", error: { ".tag": "missing_scope" } }, 401) });
    await expect(store.listTripFiles("dropbox:id:folder01")).rejects.toThrow(/Permissions tab/);
  });

  it("takes a shared link to a folder in the Dropbox, and asks to add one that isn't", async () => {
    fake({ "/2/sharing/get_shared_link_metadata": () => json({ ".tag": "folder", id: "id:shared01", name: "Japan", path_lower: "/japan" }) });
    expect(await box.folderFromLink("https://www.dropbox.com/scl/fo/x/y?rlkey=z")).toBe("dropbox:id:shared01");
    fake({ "/2/sharing/get_shared_link_metadata": () => json({ ".tag": "folder", id: "id:shared02", name: "Japan" }) });
    await expect(box.folderFromLink("https://www.dropbox.com/scl/fo/x/y")).rejects.toThrow(/Add to Dropbox/);
  });

  it("lists folders shared with you, and adds one that isn't in the Dropbox yet when it's chosen", async () => {
    fake({ "/2/sharing/list_folders": () => json({ entries: [{ name: "Friends", shared_folder_id: "111", path_lower: "/friends", access_type: { ".tag": "editor" } }, { name: "Alex", shared_folder_id: "222", access_type: { ".tag": "viewer" } }] }) });
    const shared = await box.browse("shared");
    expect(shared.entries.map((e) => [e.id, e.canWrite])).toEqual([["dropbox:ns:111", true], ["dropbox:mount:222", false]]);
    fake({
      "/2/sharing/mount_folder": () => json({ shared_folder_id: "222", path_lower: "/alex" }),
      "/2/files/get_metadata": () => json({ ".tag": "folder", id: "id:alex01", name: "Alex" }),
    });
    expect(await box.resolveFolder("dropbox:mount:222")).toBe("dropbox:id:alex01");
  });

  it("is a folder kind of its own for the sync", () => {
    expect(store.providerOf("dropbox:id:folder01")).toBe("dropbox");
    expect(store.providerOf("local:C:\\Trips")).toBe("local");
    expect(store.providerOf("1AbCdEfGhIjK")).toBe("drive");
    expect(box.ready()).toBe(true);
  });
});
