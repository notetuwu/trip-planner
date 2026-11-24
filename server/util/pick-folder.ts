// The system's own "choose a folder" dialog, opened on the computer the planner runs on (a web page can't give a folder's
// path, and the photos are read by this server). Windows: a PowerShell folder browser; macOS: AppleScript; Linux: zenity or
// kdialog when installed. Resolves with the path, or "" when the dialog was closed without choosing.
import { execFile } from "node:child_process";

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: false, maxBuffer: 1 << 20 }, (err, out, errOut) => {
    // A closed dialog is not a failure (osascript says "User canceled", zenity exits 1 with no text).
    if (err && !String(out).trim()) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      if (/cancel/i.test(String(errOut)) || (err as { code?: number }).code === 1 || !String(errOut).trim()) return resolve("");
      return reject(new Error(String(errOut).trim().slice(0, 200)));
    }
    resolve(String(out).trim());
  });
});

export async function pickFolder(prompt: string): Promise<string> {
  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${prompt.replace(/'/g, "''")}'; $f.ShowNewFolderButton = $false; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; if ($f.ShowDialog($top) -eq 'OK') { Write-Output $f.SelectedPath }`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
  }
  if (process.platform === "darwin") {
    return (await run("osascript", ["-e", `POSIX path of (choose folder with prompt "${prompt.replace(/"/g, "")}")`])).replace(/\/$/, "") || "";
  }
  try { return await run("zenity", ["--file-selection", "--directory", `--title=${prompt}`]); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    try { return await run("kdialog", ["--getexistingdirectory", process.env.HOME || "/", "--title", prompt]); }
    catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "ENOENT") throw new Error("There's no folder dialog on this system (zenity or kdialog). Type the folder's path instead.");
      throw e2;
    }
  }
}
