// The Photos layer's server side: the folder's id from what was pasted, and the photos from Drive's answer (position and
// time from the photo's own metadata, subfolders read, a photo with no position kept without one).
import { afterEach, describe, expect, it, vi } from "vitest";
import { folderId, folderPhotos } from "../server/geo/photos";

// Neither the real settings (a key saved there) nor the real cache folder take part.
vi.mock("../server/settings", () => ({ readSettings: () => ({ googleKey: "" }) }));
vi.mock("../server/util/disk-cache", () => ({ diskCache: () => ({ data: {}, save() {}, saveNow() {} }) }));
// Nor a Google sign-in on this computer (Settings → Sync): these are about the API key.
vi.mock("../server/sync/google", () => ({ bearer: async () => null }));

describe("folderId", () => {
  it("takes the id from a share link, an old-style link or the id itself", () => {
    expect(folderId("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing")).toBe("1AbCdEfGhIjKlMnOpQrStUv");
    expect(folderId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUv")).toBe("1AbCdEfGhIjKlMnOpQrStUv");
    expect(folderId("  1AbCdEfGhIjKlMnOpQrStUv ")).toBe("1AbCdEfGhIjKlMnOpQrStUv");
    expect(folderId("https://example.com/photos")).toBe("");
  });
});

describe("folderPhotos", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.GOOGLE_API_KEY; });

  it("lists photos with their spot and time, reads subfolders, and keeps one without a position", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    const folder = "1AbCdEfGhIjKlMnOpQrStUv", sub = "1SubFolderSubFolder12";
    const answers: Record<string, unknown> = {
      [folder]: { files: [
        { id: "a", name: "arena.jpg", mimeType: "image/jpeg", thumbnailLink: "https://lh3.example/a=s220", createdTime: "2027-09-20T10:00:00Z",
          imageMediaMetadata: { location: { latitude: 45.4390, longitude: 10.9942 }, time: "2027:09:14 10:30:05", width: 4000, height: 3000, rotation: 1 } },
        { id: "f", name: "Day 12", mimeType: "application/vnd.google-apps.folder" },
      ] },
      [sub]: { files: [{ id: "b", name: "no-gps.jpg", mimeType: "image/jpeg", thumbnailLink: "https://lh3.example/b=s220", createdTime: "2027-09-17T08:00:00Z", imageMediaMetadata: {} }] },
    };
    answers[folder] = { files: [...(answers[folder] as any).files.slice(0, 1), { id: sub, name: "Day 12", mimeType: "application/vnd.google-apps.folder" }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") || "");
      const dir = Object.keys(answers).find((k) => q.startsWith(`'${k}'`))!;
      return { ok: true, status: 200, json: async () => answers[dir] };
    }));
    const r = await folderPhotos(`https://drive.google.com/drive/folders/${folder}`, true);
    expect(r.total).toBe(2);
    expect(typeof r.name).toBe("string");
    expect(r.photos).toEqual([
      { id: "a", name: "arena.jpg", t: "2027-09-14T10:30:05", thumb: "https://lh3.example/a=s220", lat: 45.439, lng: 10.9942, w: 3000, h: 4000 },
      { id: "b", name: "no-gps.jpg", t: "", up: "2027-09-17T08:00:00", dir: "Day 12", thumb: "https://lh3.example/b=s220" },
    ]);
  });

  it("says what to do when there's no key, or the folder isn't shared", async () => {
    await expect(folderPhotos("1AbCdEfGhIjKlMnOpQrStUv", true)).rejects.toThrow(/Sign in with Google|API key/);
    process.env.GOOGLE_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "File not found" } }) })));
    await expect(folderPhotos("1ZzZzZzZzZzZzZzZzZzZzZ", true)).rejects.toThrow(/Anyone with the link/);
  });
});

describe("photoFile", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.GOOGLE_API_KEY; });
  const fakeRes = () => { const r: any = { status: 0, body: "", headersSent: false, writeHead(s: number) { r.status = s; }, end(b?: string) { r.body = b || ""; } }; return r; };

  it("only serves a photo that's in a folder that was listed, and keeps the key out of the answer", async () => {
    process.env.GOOGLE_API_KEY = "secret-key";
    const { photoFile } = await import("../server/geo/photos");
    const folder = "1AbCdEfGhIjKlMnOpQrStUv";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ files: [{ id: "a", name: "a.jpg", mimeType: "image/jpeg", thumbnailLink: "x=s220" }] }) })));
    await folderPhotos(folder, true);
    const res = fakeRes();
    await photoFile(folder, "somebody-elses-file", res);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("secret-key");
  });
});

describe("videos", () => {
  it("reads a time out of a file name", async () => {
    const { timeFromName } = await import("../server/geo/photos");
    expect(timeFromName("IMG_20270910_094103.jpg")).toBe("2027-09-10T09:41:03");
    expect(timeFromName("PXL_20270910_094103123.mp4")).toBe("2027-09-10T09:41:03");
    expect(timeFromName("2027-09-10 09.41.03.mov")).toBe("2027-09-10T09:41:03");
    expect(timeFromName("DSC_0042.jpg")).toBe("");
    expect(timeFromName("scan 12345678901234.png")).toBe("");
  });

  it("reads the position and creation time from a movie header, and turns the time local by the longitude", async () => {
    const { readMoov, localTime } = await import("../server/geo/photos");
    // 2027-09-10 07:41:03 UTC, seconds since 1904, in a version 0 "mvhd"; the position as "©xyz" writes it.
    const unix = Date.UTC(2027, 8, 10, 7, 41, 3) / 1000, mac = unix + 2082844800;
    const mvhd = Buffer.concat([Buffer.from("mvhd"), Buffer.from([0, 0, 0, 0]), (() => { const b = Buffer.alloc(8); b.writeUInt32BE(mac, 0); return b; })()]);
    const xyz = Buffer.concat([Buffer.from([0xa9]), Buffer.from("xyz"), Buffer.from([0, 22, 0x15, 0xc7]), Buffer.from("+47.0502+008.3093+420.000/")]);
    const r = readMoov(Buffer.concat([mvhd, xyz]));
    expect(r).toEqual({ lat: 47.0502, lng: 8.3093, created: unix });
    // Lucerne is at 8.3° east: a zone about 1 hour ahead of UTC.
    expect(localTime(unix, 8.3093)).toBe("2027-09-10T08:41:03");
    expect(localTime(unix)).toBe("2027-09-10T07:41:03");
  });

  it("finds no position or time in a header that has none", async () => {
    const { readMoov } = await import("../server/geo/photos");
    expect(readMoov(Buffer.from("moov....nothing useful here"))).toEqual({});
  });
});
