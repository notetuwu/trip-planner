// What the page knows about syncing trips through Drive (Settings → Sync): signed in as whom, the folders, and how each
// saved trip syncs. Fetched from the server (which keeps the Google sign-in to itself).
import type { SyncStatus, TripShare } from "../../../shared/types";
import { api } from "../core/dom";

export let syncStatus: SyncStatus | null = null;
const listeners: (() => void)[] = [];
/** Runs whenever the status changes (the trips dialog and Settings redraw). */
export const onSyncStatus = (fn: () => void) => { listeners.push(fn); };

export function setSyncStatus(s: SyncStatus | null) {
  syncStatus = s;
  for (const fn of listeners) fn();
}

/** The status from the server (null on a phone, which can't use sync). */
export async function loadSyncStatus(): Promise<SyncStatus | null> {
  setSyncStatus(await api<SyncStatus>("/api/sync").catch(() => null));
  return syncStatus;
}

/** Looks at the folders now (answers when done). */
export async function syncNow(): Promise<SyncStatus | null> {
  if (!syncStatus?.signedIn) return syncStatus;
  setSyncStatus(await api<SyncStatus>("/api/sync/now", { method: "POST" }).catch(() => syncStatus));
  return syncStatus;
}

export const syncReady = () => !!syncStatus?.configured && !!syncStatus.signedIn;
export const myEmail = () => (syncStatus?.signedIn ? syncStatus.email : "");
/** Whether the signed-in person shared this trip (or it isn't shared). */
export const isOwner = (share?: TripShare | null) => !share?.owner || (!!myEmail() && share.owner.toLowerCase() === myEmail().toLowerCase());
export const folderLabel = (id: string) => syncStatus?.folders.find((f) => f.id === id)?.label || "a Drive folder";
export const ownerName = (share?: TripShare | null) => share?.ownerName || share?.owner || "someone";

/** Opens Settings at the Sync tab (Settings listens; this keeps the imports one way). */
export const openSyncSettings = () => document.dispatchEvent(new CustomEvent("open-settings", { detail: "sync" }));
