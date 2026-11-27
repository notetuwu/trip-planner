// Who has access to a Drive folder or shared drive (the folder browser's "Access" window): the list, adding people,
// changing what they may do, removing them, whether anyone with the link gets in, and "limited access" (access from the
// folders above doesn't open this one). Google decides what this account may do (a folder's capabilities); everything here is only what the person clicked, nothing is shared on its own.
import type { AccessEntry, AccessRole, FolderAccess } from "../../shared/types";
import { DRIVE, FOLDER_TYPE, account, drive, isDriveId } from "./google";

/** Why a request failed, keeping Google's own words: for sharing they say what the rule is (an organisation that forbids
 *  outside sharing, an address with no Google account…). */
export class AccessError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string) { super(message); }
}

async function call(url: string, init: RequestInit = {}): Promise<any> {
  const res = await drive(url, init);
  const json: any = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const e = json?.error, reason = String(e?.errors?.[0]?.reason || ""), msg = String(e?.message || "").slice(0, 240);
  const said = res.status === 404 ? "Google can't find it (deleted, or not shared with this account)."
    : /rateLimit|quota/i.test(reason) ? "Google's sharing limit is used up for now. Try again later."
      : msg ? `Google: ${msg}` : `Google answered ${res.status}`;
  throw new AccessError(said, res.status, reason);
}
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** What a person can be given: in a shared drive also "content manager", and on the drive itself "manager". */
export function rolesFor(o: { sharedDrive: boolean; driveRoot: boolean }): AccessRole[] {
  return ["reader", "commenter", "writer", ...(o.sharedDrive ? ["fileOrganizer" as const] : []), ...(o.driveRoot ? ["organizer" as const] : [])];
}

/** One of Google's permissions, as the window shows it. */
export function accessEntry(p: any, o: { me: string; driveRoot: boolean }): AccessEntry {
  const type = ["user", "group", "domain", "anyone"].includes(p?.type) ? p.type as AccessEntry["type"] : "user";
  const email = String(p?.emailAddress || ""), domain = String(p?.domain || "");
  // On a folder with limited access, Google keeps listing those from above, as seeing its name only.
  const shutOut = p?.view === "metadata";
  // Access that only comes from a folder further up (or from the shared drive) is changed there.
  const details: any[] = Array.isArray(p?.permissionDetails) ? p.permissionDetails : [];
  const inherited = shutOut || !o.driveRoot && details.length > 0 && details.every((d) => d.inherited);
  return {
    id: String(p?.id || ""), type, role: String(p?.role || "reader") as AccessEntry["role"], email, domain,
    name: String(p?.displayName || email || domain || (type === "anyone" ? "Anyone with the link" : "Unknown")),
    me: !!email && email.toLowerCase() === o.me.toLowerCase(),
    inherited, shutOut,
    ...(p?.expirationTime ? { until: String(p.expirationTime) } : {}),
  };
}

const ORDER = ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"];

/** The folder, what this account may do with it, and everyone on it (null when Google won't say: view-only access
 *  usually can't see the others). */
export async function folderAccess(id: string): Promise<FolderAccess> {
  if (!isDriveId(id) || id === "root") throw new Error("That folder can't be shared. Choose a folder in it.");
  const f = await call(`${DRIVE}/files/${id}?fields=id,name,mimeType,driveId,inheritedPermissionsDisabled,capabilities(canShare,canDisableInheritedPermissions,canEnableInheritedPermissions)&supportsAllDrives=true`);
  if (f.mimeType !== FOLDER_TYPE) throw new Error("That's not a folder.");
  const sharedDrive = !!f.driveId, driveRoot = f.driveId === f.id, me = account().email;
  let name = String(f.name || "");
  // A shared drive's top folder is just called "Drive": its real name is the drive's.
  if (driveRoot) name = String((await call(`${DRIVE}/drives/${id}?fields=name`).catch(() => null))?.name || name);
  let people: AccessEntry[] | null = [];
  let pageToken = "";
  try {
    do {
      const q = new URLSearchParams({
        fields: "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,expirationTime,view,permissionDetails(inherited))",
        pageSize: "100", supportsAllDrives: "true", ...(pageToken ? { pageToken } : {}),
      });
      const j = await call(`${DRIVE}/files/${id}/permissions?${q}`);
      for (const p of j.permissions || []) if (!p.deleted) people.push(accessEntry(p, { me, driveRoot }));
      pageToken = j.nextPageToken || "";
    } while (pageToken && people.length < 500);
  } catch (e) {
    if (!(e instanceof AccessError) || e.status !== 403 || /rateLimit|quota/i.test(e.reason)) throw e;
    people = null;
  }
  people?.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
  const limited = !!f.inheritedPermissionsDisabled;
  const canLimit = !driveRoot && !!(limited ? f.capabilities?.canEnableInheritedPermissions : f.capabilities?.canDisableInheritedPermissions);
  return { id, name, canManage: !!f.capabilities?.canShare && people !== null, sharedDrive, driveRoot, limited, canLimit, roles: rolesFor({ sharedDrive, driveRoot }), people };
}

/** The folder as it is, if this account may change who's on it (checked here too, with the role asked for). */
async function managed(id: string, role?: string): Promise<FolderAccess> {
  const a = await folderAccess(id);
  if (!a.canManage) throw new Error("This account isn't allowed to manage who has access to this folder.");
  if (role !== undefined && !(a.roles as string[]).includes(role)) throw new Error("That kind of access can't be given here.");
  return a;
}
/** A permission already on the folder that may be changed here. */
function changeable(a: FolderAccess, permission: string): AccessEntry {
  const p = a.people!.find((x) => x.id === permission);
  if (!p) throw new Error("They no longer have access.");
  if (p.role === "owner") throw new Error("The owner's access can't be changed here.");
  if (p.shutOut) throw new Error("They can't open this folder. Add them by email to let them in.");
  if (p.inherited) throw new Error("That access comes from a folder further up. Change it there.");
  return p;
}
const permissions = (id: string, permission = "") => `${DRIVE}/files/${id}/permissions${permission ? `/${encodeURIComponent(permission)}` : ""}?supportsAllDrives=true`;

/** Gives a person (or a Google group) access, by email address. notify: Google emails them the link. */
export async function addPerson(id: string, email: string, role: string, notify: boolean): Promise<void> {
  const address = String(email || "").trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(address) || address.length > 254) throw new Error("Type one email address, like name@example.com.");
  await managed(id, role);
  const add = (type: "user" | "group") => call(`${permissions(id)}&sendNotificationEmail=${notify}`, send("POST", { type, role, emailAddress: address }));
  try { await add("user"); } catch (e) {
    // A Google group's address is refused as a person: try it as a group, else say what Google said the first time.
    if (!(e instanceof AccessError) || e.status !== 400) throw e;
    try { await add("group"); } catch { throw e; }
  }
}

export async function setRole(id: string, permission: string, role: string): Promise<void> {
  changeable(await managed(id, role), permission);
  await call(permissions(id, permission), send("PATCH", { role }));
}

export async function removeAccess(id: string, permission: string): Promise<void> {
  changeable(await managed(id), permission);
  await call(permissions(id, permission), { method: "DELETE" });
}

/** "Anyone with the link": a role turns it on (or changes it), "" back to only the people listed. */
export async function setLinkAccess(id: string, role: string): Promise<void> {
  if (role && !["reader", "commenter", "writer"].includes(role)) throw new Error("That kind of access can't be given to a link.");
  const a = await managed(id);
  const now = a.people!.find((p) => p.type === "anyone" && !p.shutOut);
  if (now?.inherited) throw new Error("The link's access comes from a folder further up. Change it there.");
  if (!role) { if (now) await call(permissions(id, now.id), { method: "DELETE" }); }
  else if (now) await call(permissions(id, now.id), send("PATCH", { role }));
  else await call(permissions(id), send("POST", { type: "anyone", role, allowFileDiscovery: false }));
}

/** Limited access on: only the owner (a shared drive's managers) and those added to this folder itself can open it;
 *  others with access above still see its name. Off: access from above opens it again. */
export async function setLimited(id: string, limited: boolean): Promise<void> {
  const a = await folderAccess(id);
  if (a.limited === limited) return;
  if (!a.canLimit) throw new Error("This account isn't allowed to change limited access on this folder.");
  await call(`${DRIVE}/files/${id}?supportsAllDrives=true&fields=id`, send("PATCH", { inheritedPermissionsDisabled: limited }));
}
