// Profile pictures of the people who work on synced trips, from Google Drive and Dropbox: your own and those of whoever
// a sync folder is shared with. Shown on the "who changed this" marks. Kept on this computer only, by email address
// (never written into a trip's file), and only the picture's address: the picture itself comes from Google or Dropbox.
import { diskCache } from "../util/disk-cache";
import * as box from "./dropbox";
import * as g from "./google";

const kept = diskCache<{ url: string }>("people.json");
/** When each thing was last asked for: once an hour is plenty. */
const asked = new Map<string, number>();
const HOUR = 3600_000;

export function remember(list: { email?: string; url?: string }[]) {
  let changed = false;
  for (const { email, url } of list) {
    const key = String(email || "").trim().toLowerCase();
    if (!key || !/^https:\/\//.test(url || "") || kept.data[key]?.url === url) continue;
    kept.data[key] = { url: url! };
    changed = true;
  }
  if (changed) kept.save();
}

export const pictureOf = (email: string) => kept.data[email.trim().toLowerCase()]?.url || "";
/** Every picture known, as [email, address]. */
export const knownPictures = () => Object.entries(kept.data).map(([email, p]) => [email, p.url] as const);

/** Asks for your own picture and those of the people on a sync folder. A picture is a nicety: when the service doesn't
 *  say (or the folder's members can't be seen), initials stay. */
export async function refreshPeople(folder: string, provider: "drive" | "dropbox") {
  const once = async (key: string, ask: () => Promise<{ email?: string; url?: string }[]>) => {
    if (Date.now() - (asked.get(key) || 0) < HOUR) return;
    asked.set(key, Date.now());
    try { remember(await ask()); } catch { /* initials */ }
  };
  const from = provider === "drive" ? g : box;
  await once(`me:${provider}`, () => from.myPicture());
  await once(folder, () => from.folderPeople(folder));
}
