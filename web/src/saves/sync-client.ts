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
  if (!syncStatus?.folders.length) return syncStatus;
  setSyncStatus(await api<SyncStatus>("/api/sync/now", { method: "POST" }).catch(() => syncStatus));
  return syncStatus;
}

/** There are sync folders (Drive or on this computer) to show trips from. */
export const syncReady = () => !!syncStatus?.folders.length;
/** Whether this person shared the trip (as their Google account or as this computer's user), or it isn't shared. */
export const isOwner = (share?: TripShare | null) => !share || (!!share.owner && (syncStatus?.identities || []).some((id) => id.toLowerCase() === share.owner.toLowerCase()));
export const isLocalFolder = (id: string) => id.startsWith("local:");
export const folderLabel = (id: string) => syncStatus?.folders.find((f) => f.id === id)?.label || "a sync folder";
export const ownerName = (share?: TripShare | null) => share?.ownerName || share?.owner || "someone";

/** Opens Settings at the Sync tab (Settings listens; this keeps the imports one way). */
export const openSyncSettings = () => document.dispatchEvent(new CustomEvent("open-settings", { detail: "sync" }));
