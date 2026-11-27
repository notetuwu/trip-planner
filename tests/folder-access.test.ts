// Who has access to a Drive folder: what Google says turned into the window's list, and no change without the right to
// make it. Google is stood in for; nothing leaves this computer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let g: typeof import("../server/sync/google-access");
const FOLDER = "folder-1234567890";
let limited = false, canLimit = true;
let canShare = true, permissions: any[] = [], listStatus = 200;
let sent: { method: string; url: string; body: any }[] = [];

const reply = (status: number, json: unknown) => new Response(status === 204 ? null : JSON.stringify(json), { status });

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-access-"));
  process.env.TRIP_PLANNER_DATA = root;
  process.env.GOOGLE_CLIENT_ID = "1234567890-abcdefg.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-abcdefghij1234567890";
  fs.mkdirSync(path.join(root, "sync"), { recursive: true });
  fs.writeFileSync(path.join(root, "sync", "google-auth.json"), JSON.stringify({ refresh: "r", email: "me@example.com", name: "Me", at: 0 }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return reply(200, { access_token: "t", expires_in: 3600 });
    const method = init.method || "GET";
    if (method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      sent.push({ method, url, body });
      if (body?.type === "user" && body.emailAddress === "club@example.com") return reply(400, { error: { message: "That is a group.", errors: [{ reason: "invalidSharingRequest" }] } });
      return reply(method === "DELETE" ? 204 : 200, {});
    }
    if (url.includes("/permissions")) return listStatus === 200 ? reply(200, { permissions }) : reply(listStatus, { error: { message: "No.", errors: [{ reason: "insufficientFilePermissions" }] } });
    return reply(200, { id: FOLDER, name: "Japan", mimeType: "application/vnd.google-apps.folder", inheritedPermissionsDisabled: limited, capabilities: { canShare, canDisableInheritedPermissions: canLimit, canEnableInheritedPermissions: canLimit } });
  });
  g = await import("../server/sync/google-access");
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  limited = false; canLimit = true;
  canShare = true; listStatus = 200; sent = [];
  permissions = [
    { id: "p2", type: "user", role: "reader", emailAddress: "ann@example.com", displayName: "Ann" },
    { id: "p1", type: "user", role: "owner", emailAddress: "Me@Example.com", displayName: "Me" },
    { id: "p3", type: "user", role: "writer", emailAddress: "gone@example.com", deleted: true },
  ];
});

describe("who has access to a Drive folder", () => {
  it("lists them, the owner first, and marks your own", async () => {
    const a = await g.folderAccess(FOLDER);
    expect(a.canManage).toBe(true);
    expect(a.people!.map((p) => [p.name, p.role, p.me])).toEqual([["Me", "owner", true], ["Ann", "reader", false]]);
    expect(a.roles).toEqual(["reader", "commenter", "writer"]);
  });

  it("offers shared drives' roles there, and knows access from further up", () => {
    expect(g.rolesFor({ sharedDrive: true, driveRoot: true })).toContain("organizer");
    expect(g.rolesFor({ sharedDrive: true, driveRoot: false })).not.toContain("organizer");
    const p = { id: "x", type: "user", role: "writer", permissionDetails: [{ inherited: true }] };
    expect(g.accessEntry(p, { me: "", driveRoot: false }).inherited).toBe(true);
    expect(g.accessEntry(p, { me: "", driveRoot: true }).inherited).toBe(false);
  });

  it("says so when Google won't list the others", async () => {
    canShare = false; listStatus = 403;
    expect(await g.folderAccess(FOLDER)).toMatchObject({ canManage: false, people: null });
  });

  it("changes nothing without the right to", async () => {
    canShare = false;
    await expect(g.addPerson(FOLDER, "bo@example.com", "writer", true)).rejects.toThrow(/isn't allowed/);
    await expect(g.removeAccess(FOLDER, "p2")).rejects.toThrow(/isn't allowed/);
    await expect(g.setLinkAccess(FOLDER, "reader")).rejects.toThrow(/isn't allowed/);
    expect(sent).toEqual([]);
  });

  it("leaves the owner be, and refuses roles and addresses that can't work", async () => {
    await expect(g.removeAccess(FOLDER, "p1")).rejects.toThrow(/owner/);
    await expect(g.setRole(FOLDER, "p2", "owner")).rejects.toThrow(/can't be given/);
    await expect(g.setLinkAccess(FOLDER, "organizer")).rejects.toThrow(/can't be given/);
    await expect(g.addPerson(FOLDER, "a@b.com, c@d.com", "reader", true)).rejects.toThrow(/one email/);
    await expect(g.folderAccess("root")).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("adds, changes and removes", async () => {
    await g.addPerson(FOLDER, " bo@example.com ", "writer", false);
    await g.setRole(FOLDER, "p2", "writer");
    await g.removeAccess(FOLDER, "p2");
    expect(sent.map((s) => s.method)).toEqual(["POST", "PATCH", "DELETE"]);
    expect(sent[0].body).toEqual({ type: "user", role: "writer", emailAddress: "bo@example.com" });
    expect(sent[0].url).toContain("sendNotificationEmail=false");
    expect(sent[1].url).toContain(`/files/${FOLDER}/permissions/p2?`);
  });

  it("shares with a group when its address is refused as a person", async () => {
    await g.addPerson(FOLDER, "club@example.com", "reader", true);
    expect(sent.map((s) => s.body.type)).toEqual(["user", "group"]);
  });

  it("limits access and removes the limit, only with the right to", async () => {
    await g.setLimited(FOLDER, true);
    expect(sent).toMatchObject([{ method: "PATCH", body: { inheritedPermissionsDisabled: true } }]);
    limited = true;
    expect(await g.folderAccess(FOLDER)).toMatchObject({ limited: true, canLimit: true });
    await g.setLimited(FOLDER, false);
    expect(sent[1].body).toEqual({ inheritedPermissionsDisabled: false });
    canLimit = false; sent = [];
    await expect(g.setLimited(FOLDER, false)).rejects.toThrow(/isn't allowed/);
    expect(sent).toEqual([]);
  });

  it("knows who limited access shuts out, a link from above too", async () => {
    limited = true;
    permissions.push({ id: "p4", type: "user", role: "reader", view: "metadata", emailAddress: "bo@example.com" },
      { id: "anyoneWithLink", type: "anyone", role: "reader", view: "metadata" });
    expect((await g.folderAccess(FOLDER)).people!.find((p) => p.id === "p4")).toMatchObject({ shutOut: true, inherited: true });
    await expect(g.removeAccess(FOLDER, "p4")).rejects.toThrow(/can't open/);
    await g.setLinkAccess(FOLDER, "");
    expect(sent).toEqual([]);
  });

  it("turns the link on, changes it and off again", async () => {
    await g.setLinkAccess(FOLDER, "reader");
    expect(sent[0]).toMatchObject({ method: "POST", body: { type: "anyone", role: "reader", allowFileDiscovery: false } });
    permissions.push({ id: "anyoneWithLink", type: "anyone", role: "reader" });
    await g.setLinkAccess(FOLDER, "writer");
    await g.setLinkAccess(FOLDER, "");
    expect(sent.slice(1).map((s) => s.method)).toEqual(["PATCH", "DELETE"]);
  });
});
