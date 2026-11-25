// Syncing trips through Drive folders, against a pretend Drive: uploads, downloads, clashes (never overwritten), view-only
// trips, nothing deleted in Drive, and nothing of this computer's (photo folders on disk, list file paths, prompts) sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const drive = vi.hoisted(() => ({
  files: new Map<string, { id: string; name: string; folder: string; text: string; md5: string; by: string; byEmail: string; canEdit: boolean }>(),
  me: { email: "me@example.com", name: "Me" },
  canWrite: true,
  uploads: 0,
  n: 0,
}));

vi.mock("../server/sync/google", async () => {
  const crypto = await import("node:crypto");
  const nodePath = await import("node:path");
  const md5 = (t: string) => crypto.createHash("md5").update(t).digest("hex");
  const meta = (f: any) => ({ id: f.id, name: f.name, md5Checksum: f.md5, modifiedTime: "2026-11-25T10:00:00Z", lastModifyingUser: { displayName: f.by, emailAddress: f.byEmail }, capabilities: { canEdit: f.canEdit } });
  return {
    SYNC_DIR: nodePath.join(process.env.TRIP_PLANNER_DATA!, "sync"),
    TRIP_SUFFIX: ".trip.json",
    SignedOut: class SignedOut extends Error {},
    client: () => ({ id: "client", secret: "secret" }),
    clientInfo: () => ({ clientFrom: "app", clientId: "client" }),
    account: () => ({ signedIn: true, expired: false, ...drive.me }),
    signInState: () => ({ signingIn: false, signInError: "" }),
    isDriveId: (id: unknown) => typeof id === "string" && /^[\w-]{10,200}$/.test(id),
    folderInfo: async (id: string) => ({ id, name: `Drive ${id}`, canWrite: drive.canWrite }),
    createFolder: async (name: string) => ({ id: `folder${++drive.n}xxxxxx`, name, canWrite: true }),
    listTripFiles: async (folder: string) => [...drive.files.values()].filter((f) => f.folder === folder).map(meta),
    fileMeta: async (id: string) => meta(drive.files.get(id)),
    download: async (id: string) => drive.files.get(id)!.text,
    upload: async (o: { id?: string; folder?: string; name: string; text: string }) => {
      drive.uploads++;
      const was = o.id ? drive.files.get(o.id)! : undefined;
      const f = { id: o.id || `file${++drive.n}xxxxxxxx`, name: o.name, folder: was?.folder || o.folder!, text: o.text, md5: md5(o.text), by: drive.me.name, byEmail: drive.me.email, canEdit: true };
      drive.files.set(f.id, f);
      return meta(f);
    },
    signOut: async () => {},
  };
});

let sync: typeof import("../server/sync/sync");
let root = "", saves = "";
const FOLDER = "folderAAAAAAAAAA", FOLDER2 = "folderBBBBBBBBBB";

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-sync-"));
  process.env.TRIP_PLANNER_DATA = root;
  saves = path.join(root, "saves");
  sync = await import("../server/sync/sync");
});

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(saves, { recursive: true });
  drive.files.clear(); drive.uploads = 0; drive.canWrite = true;
  drive.me = { email: "me@example.com", name: "Me" };
  sync.resetForTests(true);
});

const trip = (extra: object = {}) => ({ stays: [{ city: "Kyoto", start: "2027-04-01", nights: 3, hotel: "" }], marks: {}, notes: "", ...extra });
const writeSave = (name: string, t: object) => fs.writeFileSync(path.join(saves, `${name}.json`), JSON.stringify(t));
const readSave = (name: string) => JSON.parse(fs.readFileSync(path.join(saves, `${name}.json`), "utf8"));
const versions = (name: string) => { try { return fs.readdirSync(path.join(saves, ".history", name)).length; } catch { return 0; } };
const round = async () => { sync.resetForTests(); await sync.runSync(); };
const onlyFile = () => { expect(drive.files.size).toBe(1); return [...drive.files.values()][0]; };
/** Someone else saves the trip in Drive. */
function remoteEdit(change: (t: any) => void, by = { name: "Friend", email: "friend@example.com" }) {
  const f = onlyFile(), data = JSON.parse(f.text);
  change(data.trip);
  f.text = JSON.stringify(data); f.md5 = `md5-${Math.random()}`; f.by = by.name; f.byEmail = by.email;
}

async function shareTrip(name = "Kyoto", t: object = trip(), mode?: "edit" | "view") {
  writeSave(name, t);
  await sync.addFolder(FOLDER, "Friends");
  const r = await sync.setTripSync(name, [FOLDER], mode);
  await round();
  return r.sync!;
}

describe("syncing a trip with a Drive folder", () => {
  it("uploads a newly shared trip, without this computer's photo folders, list file paths or prompts", async () => {
    fs.mkdirSync(path.join(root, "lists"), { recursive: true });
    fs.writeFileSync(path.join(root, "lists", "Mine.json"), JSON.stringify({ name: "Mine", source: { type: "csv", file: "C:\\Users\\me\\secret.csv" }, places: [{ title: "Temple", lat: 1, lng: 2 }] }));
    const share = await shareTrip("Kyoto", trip({
      lists: ["Mine"], list: "Mine",
      photoFolders: [{ link: "local:C:\\Users\\me\\Pictures" }, { link: "https://drive.google.com/drive/folders/abcdefghijkl" }],
      meta: { prompt: [{ label: "p", text: "secret prompt" }], thinking: "hmm", costUsd: 1 },
    }));
    expect(share.owner).toBe("me@example.com");
    const f = onlyFile();
    expect(f.name).toBe("Kyoto.trip.json");
    expect(f.text).not.toContain("Pictures");
    expect(f.text).not.toContain("secret.csv");
    expect(f.text).not.toContain("secret prompt");
    expect(f.text).not.toContain("hmm");
    const data = JSON.parse(f.text);
    expect(data.trip.sync.id).toBe(share.id);
    expect(data.trip.photoFolders).toEqual([{ link: "https://drive.google.com/drive/folders/abcdefghijkl" }]);
    expect(data.lists[0].source).toBeUndefined();
    expect(readSave("Kyoto").sync.id).toBe(share.id);
  });

  it("doesn't upload again when nothing changed, or the page wrote the same trip with its keys in another order", async () => {
    await shareTrip();
    expect(drive.uploads).toBe(1);
    await round();
    const t = readSave("Kyoto");
    writeSave("Kyoto", Object.fromEntries(Object.entries(t).reverse()));
    await round();
    expect(drive.uploads).toBe(1);
  });

  it("uploads changes made here", async () => {
    await shareTrip();
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "bring an umbrella" });
    await round();
    expect(drive.uploads).toBe(2);
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("bring an umbrella");
  });

  it("takes changes from Drive into the save, keeping what it held as a version, and refuses a page writing an older copy", async () => {
    await shareTrip();
    remoteEdit((t) => { t.notes = "from my friend"; });
    const before = Date.now() - 1;
    await round();
    expect(readSave("Kyoto").notes).toBe("from my friend");
    expect(readSave("Kyoto").saveName).toBe("Kyoto");
    expect(versions("Kyoto")).toBeGreaterThan(0);
    expect(drive.uploads).toBe(1);
    // A page that loaded the trip before is refused; one that has seen the update isn't.
    expect(sync.staleWrite("Kyoto", String(before))).toBe(true);
    expect(sync.staleWrite("Kyoto", String(Date.now() + 1))).toBe(false);
    expect(sync.staleWrite("Kyoto", undefined)).toBe(false);
  });

  it("never overwrites when both sides changed: it waits for a decision, and either choice keeps the other version", async () => {
    await shareTrip();
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "mine" });
    remoteEdit((t) => { t.notes = "theirs"; });
    await round();
    expect(readSave("Kyoto").notes).toBe("mine");
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("theirs");
    expect(drive.uploads).toBe(1);
    expect(sync.status().trips.Kyoto.conflicts).toEqual([{ folder: FOLDER, by: "Friend", at: "2026-11-25T10:00:00Z" }]);
    // Another round changes nothing while it waits.
    await round();
    expect(readSave("Kyoto").notes).toBe("mine");
    expect(drive.uploads).toBe(1);

    const v = versions("Kyoto");
    await sync.resolve("Kyoto", FOLDER, "mine");
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("mine");
    expect(versions("Kyoto")).toBe(v + 1); // Drive's version, kept here
    expect(sync.status().trips.Kyoto.conflicts).toEqual([]);
  });

  it("taking Drive's version in a clash keeps this computer's as a version", async () => {
    await shareTrip();
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "mine" });
    remoteEdit((t) => { t.notes = "theirs"; });
    await round();
    await sync.resolve("Kyoto", FOLDER, "theirs");
    expect(readSave("Kyoto").notes).toBe("theirs");
    const hist = path.join(saves, ".history", "Kyoto");
    const kept = fs.readdirSync(hist).map((f) => JSON.parse(fs.readFileSync(path.join(hist, f), "utf8")).notes);
    expect(kept).toContain("mine");
    expect(drive.uploads).toBe(1);
  });

  it("never deletes in Drive: deleting the save or removing the folder only stops syncing, and a file removed in Drive isn't put back", async () => {
    await shareTrip();
    sync.beforeDelete("Kyoto");
    fs.unlinkSync(path.join(saves, "Kyoto.json"));
    await round();
    expect(drive.files.size).toBe(1);

    await shareTrip("Osaka", trip({ stays: [{ city: "Osaka", start: "", nights: 2, hotel: "" }] }));
    expect(drive.files.size).toBe(2);
    sync.removeFolder(FOLDER);
    writeSave("Osaka", { ...readSave("Osaka"), notes: "changed" });
    await round();
    expect(drive.files.size).toBe(2);
    expect(drive.uploads).toBe(2);

    // Removed in Drive by someone: it stops syncing there and isn't uploaded again.
    drive.files.clear();
    await sync.addFolder(FOLDER, "Friends");
    await sync.setTripSync("Osaka", [FOLDER]);
    await round();
    expect(drive.files.size).toBe(1);
    drive.files.clear();
    writeSave("Osaka", { ...readSave("Osaka"), notes: "again" });
    await round();
    expect(drive.files.size).toBe(0);
    expect(sync.status().notices[0]).toMatch(/removed from "Friends"/);
  });

  it("a renamed save keeps syncing (the new save has the same trip)", async () => {
    await shareTrip();
    writeSave("Kyoto spring", { ...readSave("Kyoto"), saveName: "Kyoto spring" });
    sync.beforeDelete("Kyoto");
    fs.unlinkSync(path.join(saves, "Kyoto.json"));
    writeSave("Kyoto spring", { ...readSave("Kyoto spring"), notes: "renamed" });
    await round();
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("renamed");
    expect(onlyFile().name).toBe("Kyoto spring.trip.json");
  });
});

describe("trips other people shared", () => {
  /** The owner shares a trip; then this computer is a friend's, who opens it from the folder. */
  async function asFriend(mode: "edit" | "view") {
    await shareTrip("Kyoto", trip(), mode);
    fs.rmSync(saves, { recursive: true, force: true }); fs.mkdirSync(saves, { recursive: true });
    fs.rmSync(path.join(root, "sync"), { recursive: true, force: true });
    sync.resetForTests(true);
    drive.me = { email: "friend@example.com", name: "Friend" };
    await sync.addFolder(FOLDER, "From Me");
    await round();
    const f = onlyFile();
    return sync.openRemote(FOLDER, f.id);
  }

  it("opens a trip from a folder as a save that syncs, keeping who shared it", async () => {
    const { name } = await asFriend("edit");
    expect(name).toBe("Kyoto");
    expect(readSave("Kyoto").sync.owner).toBe("me@example.com");
    const info = sync.status().trips.Kyoto;
    expect(info.mine).toBe(false);
    expect(info.canEdit).toBe(true);
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "friend's idea" });
    await round();
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("friend's idea");
  });

  it("a friend can't make themselves the owner or change edit/view, even by editing their save", async () => {
    await asFriend("edit");
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "x", sync: { ...readSave("Kyoto").sync, owner: "friend@example.com", mode: "view" } });
    await round();
    const up = JSON.parse(onlyFile().text).trip.sync;
    expect(up.owner).toBe("me@example.com");
    expect(up.mode).toBe("edit");
  });

  it("view only: changes made by the friend stay on their computer, and the owner's updates replace them (kept as a version)", async () => {
    await asFriend("view");
    expect(sync.status().trips.Kyoto.canEdit).toBe(false);
    const uploads = drive.uploads;
    writeSave("Kyoto", { ...readSave("Kyoto"), notes: "friend's change" });
    await round();
    expect(drive.uploads).toBe(uploads);
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("");
    remoteEdit((t) => { t.notes = "owner's update"; }, { name: "Me", email: "me@example.com" });
    await round();
    expect(readSave("Kyoto").notes).toBe("owner's update");
    const hist = path.join(saves, ".history", "Kyoto");
    expect(fs.readdirSync(hist).map((f) => JSON.parse(fs.readFileSync(path.join(hist, f), "utf8")).notes)).toContain("friend's change");
  });

  it("a view-only trip can't be added to another folder by a friend", async () => {
    await asFriend("view");
    await sync.addFolder(FOLDER2, "Mine");
    await sync.setTripSync("Kyoto", [FOLDER, FOLDER2]);
    await round();
    expect(drive.files.size).toBe(1);
    expect(sync.status().trips.Kyoto.folders).toEqual([FOLDER]);
  });

  it("place lists that come with a shared trip can't point at files on this computer, and photo folders on the other computer are dropped", async () => {
    await shareTrip();
    remoteEdit((t) => { t.photoFolders = [{ link: "local:C:\\Users\\friend\\Pictures" }]; t.lists = ["Evil"]; });
    const f = onlyFile(), data = JSON.parse(f.text);
    data.lists = [{ name: "Evil", source: { type: "csv", file: "C:\\Windows\\win.ini" }, places: [{ title: "A" }] }];
    f.text = JSON.stringify(data); f.md5 = "md5-lists";
    await round();
    const list = JSON.parse(fs.readFileSync(path.join(root, "lists", "Evil.json"), "utf8"));
    expect(list.source).toEqual({ type: "upload" });
    expect(readSave("Kyoto").photoFolders).toEqual([]);
  });
});

describe("trip files put in a folder by hand", () => {
  const put = (name: string, content: unknown) => drive.files.set("handfileAAAAAAAA", { id: "handfileAAAAAAAA", name, folder: FOLDER, text: JSON.stringify(content), md5: "md5-hand", by: "Me", byEmail: "me@example.com", canEdit: true });

  it("shows any .json holding a trip, opens it as a synced save, and keeps the file's name", async () => {
    put("Central Europe Trip.json", trip({ notes: "from the other planner" }));
    await sync.addFolder(FOLDER, "Friends");
    await round();
    expect(sync.remoteTrips().map((r) => r.file.name)).toEqual(["Central Europe Trip.json"]);
    const { name } = await sync.openRemote(FOLDER, "handfileAAAAAAAA");
    expect(name).toBe("Central Europe Trip");
    await round();
    expect(drive.uploads).toBe(0); // left as it is until something changes
    expect(sync.remoteTrips()).toEqual([]);
    writeSave(name, { ...readSave(name), notes: "changed here" });
    await round();
    expect(onlyFile().name).toBe("Central Europe Trip.json");
    expect(JSON.parse(onlyFile().text).trip.notes).toBe("changed here");
  });

  it("takes a newer hand-made copy of the file as the same trip, and leaves other .json files out", async () => {
    put("Trip.json", trip());
    drive.files.set("otherfileAAAAAAA", { id: "otherfileAAAAAAA", name: "settings.json", folder: FOLDER, text: "{\"a\":1}", md5: "md5-other", by: "Me", byEmail: "me@example.com", canEdit: true });
    await sync.addFolder(FOLDER, "Friends");
    await round();
    expect(sync.remoteTrips().map((r) => r.file.name)).toEqual(["Trip.json"]);
    await sync.openRemote(FOLDER, "handfileAAAAAAAA");
    put("Trip.json", trip({ notes: "exported again" }));
    drive.files.get("handfileAAAAAAAA")!.md5 = "md5-hand-2";
    await round();
    expect(readSave("Trip").notes).toBe("exported again");
  });
});

describe("folder links", () => {
  it("reads the folder id from a share link or the bare id, and nothing else", () => {
    expect(sync.folderIdOf("https://drive.google.com/drive/folders/1AbC-def_ghiJKL?usp=sharing")).toBe("1AbC-def_ghiJKL");
    expect(sync.folderIdOf("https://drive.google.com/open?id=1AbC-def_ghiJKL")).toBe("1AbC-def_ghiJKL");
    expect(sync.folderIdOf("1AbC-def_ghiJKL")).toBe("1AbC-def_ghiJKL");
    expect(sync.folderIdOf("x' or name contains '")).toBe("");
  });
});
