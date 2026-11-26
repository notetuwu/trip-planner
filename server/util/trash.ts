// Deleting a file on this computer: into the Recycle Bin / Trash, so it can be got back. Windows has no Recycle Bin on
// network and removable drives: a file there can only be deleted for good, which the page says before asking.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DeleteKind = "trash" | "permanent";

const run = (cmd: string, args: string[], env: Record<string, string> = {}) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { windowsHide: true, timeout: 30000, env: { ...process.env, ...env } }, (err, out, errOut) =>
    (err ? reject(new Error(String(errOut || "").trim().split(/\r?\n/)[0] || err.message)) : resolve(String(out).trim()))));
const powershell = (command: string, env: Record<string, string>) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${command}`], env);

/** By drive ("D:\"): asked once. */
const kinds = new Map<string, Promise<DeleteKind>>();

/** What deleting a file under `dir` does. When Windows can't say what the drive is, it counts as one with no bin. */
export function deleteKind(dir: string): Promise<DeleteKind> {
  if (process.platform !== "win32") return Promise.resolve("trash");
  const root = path.parse(path.resolve(dir)).root.toUpperCase();
  if (!/^[A-Z]:\\$/.test(root)) return Promise.resolve("permanent");
  let kind = kinds.get(root);
  if (!kind) {
    kind = powershell("[System.IO.DriveInfo]::new($env:TP_DRIVE).DriveType", { TP_DRIVE: root })
      .then((type): DeleteKind => (type === "Fixed" ? "trash" : "permanent"), (): DeleteKind => { kinds.delete(root); return "permanent"; });
    kinds.set(root, kind);
  }
  return kind;
}

/** Moves the file to the bin. Throws (and leaves the file) when that can't be done: it's never deleted for good here. */
export async function moveToTrash(file: string): Promise<void> {
  // (The path goes in by an environment variable or as an argument, never as part of a command.)
  if (process.platform === "win32") await powershell("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:TP_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')", { TP_FILE: file });
  else if (process.platform === "darwin") await run("osascript", ["-e", "on run argv", "-e", "tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)", "-e", "end run", file]);
  else await run("gio", ["trash", "--", file]);
  if (fs.existsSync(file)) throw new Error("The file couldn't be moved to the trash.");
}
