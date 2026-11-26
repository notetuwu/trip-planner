// Photos and videos from a folder on this computer: what's listed (position, time and turn from the pictures' own EXIF),
// what isn't, and the file served in parts for a video to be played and sought in, never from outside the folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jpeg } from "./helpers/jpeg";

// The kept details of each file don't go to the real cache folder.
vi.mock("../server/util/disk-cache", () => ({ diskCache: () => ({ data: {}, save() {}, saveNow() {} }) }));

// Nor does anything go to the real Recycle Bin.
vi.mock("../server/util/trash", () => ({ deleteKind: async () => "permanent", moveToTrash: async () => { throw new Error("not in tests"); } }));

class FakeRes extends Writable {
  status = 0; headers: Record<string, string> = {}; chunks: Buffer[] = [];
  writeHead(s: number, h: Record<string, string> = {}) { this.status = s; this.headers = h; return this; }
  _write(c: Buffer, _e: string, cb: () => void) { this.chunks.push(Buffer.from(c)); cb(); }
  get body() { return Buffer.concat(this.chunks); }
  done() { return new Promise<void>((r) => this.on("finish", () => r())); }
}

let dir = "", link = "";
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trip-photos-"));
  link = `local:${dir}`;
  fs.writeFileSync(path.join(dir, "arena.jpg"), jpeg());
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a photo");
  fs.writeFileSync(path.join(dir, "iphone.HEIC"), "heic");
  fs.mkdirSync(path.join(dir, "Day 12"));
  fs.writeFileSync(path.join(dir, "Day 12", "IMG_20270917_083000.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.from("0123456789abcdefghij"));
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("listLocal", () => {
  it("lists pictures with their position, time and turn, reads subfolders, and skips what can't be shown", async () => {
    const { listLocal } = await import("../server/geo/local-photos");
    const r = await listLocal(link);
    expect(r.skipped).toBe(1);
    const byName = Object.fromEntries(r.photos.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["IMG_20270917_083000.jpg", "arena.jpg", "clip.mp4"]);
    expect(byName["arena.jpg"]).toMatchObject({ id: "arena.jpg", t: "2027-09-10T09:41:03", rot: 90 });
    expect(byName["arena.jpg"].lat).toBeCloseTo(47.0502, 4);
    expect(byName["arena.jpg"].thumb).toContain("/api/photos/thumb?folder=");
    expect(byName["arena.jpg"].thumb.endsWith("&px=s220")).toBe(true);
    // No EXIF: the time from the name; the folder it's in is kept.
    expect(byName["IMG_20270917_083000.jpg"]).toMatchObject({ id: "Day 12/IMG_20270917_083000.jpg", t: "2027-09-17T08:30:00", dir: "Day 12" });
    expect(byName["clip.mp4"].video).toBe(true);
    // In the order taken, those with no time last.
    expect(r.photos.map((p) => p.name)).toEqual(["arena.jpg", "IMG_20270917_083000.jpg", "clip.mp4"]);
  });

  it("says what's wrong with a folder that isn't there", async () => {
    const { listLocal } = await import("../server/geo/local-photos");
    await expect(listLocal(`local:${path.join(dir, "nope")}`)).rejects.toThrow(/isn't on this computer/);
  });
});

describe("localDelete", () => {
  it("deletes only a listed file, and for good only when that was agreed to", async () => {
    const { listLocal, localDelete } = await import("../server/geo/local-photos");
    const file = path.join(dir, "gone.jpg");
    fs.writeFileSync(file, jpeg());
    expect((await listLocal(link)).photos.find((p) => p.id === "gone.jpg")?.del).toBe("permanent");
    await expect(localDelete(link, "notes.txt", true)).rejects.toThrow(/isn't in the folder/);
    await expect(localDelete(link, "gone.jpg", false)).rejects.toThrow(/no Recycle Bin/);
    expect(fs.existsSync(file)).toBe(true);
    await localDelete(link, "gone.jpg", true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });
});

describe("localFile", () => {
  it("serves the whole file, or the part asked for with the range the way a video player does", async () => {
    const { localFile } = await import("../server/geo/local-photos");
    let res = new FakeRes();
    await localFile(link, "clip.mp4", res as never, "bytes=5-9"); await res.done();
    expect(res.status).toBe(206);
    expect(res.headers["Content-Range"]).toBe("bytes 5-9/20");
    expect(res.headers["Content-Type"]).toBe("video/mp4");
    expect(res.body.toString()).toBe("56789");
    res = new FakeRes();
    await localFile(link, "clip.mp4", res as never, "bytes=15-"); await res.done();
    expect(res.body.toString()).toBe("fghij");
    res = new FakeRes();
    await localFile(link, "clip.mp4", res as never); await res.done();
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(20);
  });

  it("never serves a file outside the folder or one that wasn't listed", async () => {
    const { localFile } = await import("../server/geo/local-photos");
    for (const id of ["../outside.txt", "notes.txt", "Day 12/../../x"]) {
      const res = new FakeRes();
      await localFile(link, id, res as never); await res.done();
      expect(res.status).toBe(404);
    }
  });
});
