// What a pasted folder link or path is (the folder browser, Settings → Sync, the Photos window): a Google Drive folder, a
// folder on this computer or a network drive, a link from another cloud (not usable here yet), or nothing known.
// No page or server code here, so it can be tested.

/** What a pasted text is: a Google Drive folder, a path on this computer, a link from another cloud, or nothing known. */
export function classifyLink(raw: string): { kind: "drive"; id: string } | { kind: "dropbox"; url: string } | { kind: "local"; path: string } | { kind: "cloud"; name: string } | { kind: "unknown" } {
  const s = raw.trim().replace(/^["']+|["']+$/g, "");
  const drive = s.match(/drive\.google\.com\/.*?(?:\/folders\/|[?&]id=)([\w-]{10,})/);
  if (drive) return { kind: "drive", id: drive[1] };
  if (/^https?:\/\/(www\.)?dropbox\.com\/(scl\/fo|sh)\//i.test(s)) return { kind: "dropbox", url: s };
  if (/^local:/i.test(s) || /^([a-z]:[\\/]|\\\\|\/|~[\\/]?|file:\/\/)/i.test(s)) return { kind: "local", path: s.replace(/^local:/i, "") };
  const cloud = /1drv\.ms|onedrive\.live\.com|sharepoint\.com/i.test(s) ? "OneDrive" : /dropbox\.com/i.test(s) ? "Dropbox" : /icloud\.com/i.test(s) ? "iCloud" : /box\.com/i.test(s) ? "Box" : "";
  if (cloud) return { kind: "cloud", name: cloud };
  return { kind: "unknown" };
}

