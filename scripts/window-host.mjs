// Builds the Windows app's own window (packaging/window/TripWindow.cs) with the C# compiler that is part of Windows,
// against Microsoft's WebView2 package from NuGet (a pinned version, checked against its SHA-256). Used by
// scripts/package.mjs, which bakes the files into the app (server/window-host.ts unpacks and starts them).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = "1.0.4370.26";
const SHA256 = "1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4";
const ROOT = path.resolve(import.meta.dirname, "..");

/** Builds it into `out` (which is emptied); returns the files the window needs, by name. */
export async function buildWindowHost(out) {
  fs.rmSync(out, { recursive: true, force: true });
  const pkg = path.join(out, "package"), bin = path.join(out, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const res = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/microsoft.web.webview2.${VERSION}.nupkg`);
  if (!res.ok) throw new Error(`WebView2 package: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash("sha256").update(data).digest("hex") !== SHA256) throw new Error("WebView2 package: checksum mismatch.");
  fs.writeFileSync(path.join(out, "webview2.zip"), data);
  execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${path.join(out, "webview2.zip")}' -DestinationPath '${pkg}' -Force`], { stdio: "inherit" });

  const libs = ["lib/net462/Microsoft.Web.WebView2.Core.dll", "lib/net462/Microsoft.Web.WebView2.WinForms.dll", "runtimes/win-x64/native/WebView2Loader.dll", "LICENSE.txt"];
  for (const f of libs) fs.copyFileSync(path.join(pkg, f), path.join(bin, f === "LICENSE.txt" ? "WebView2-LICENSE.txt" : path.basename(f)));

  const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  execFileSync(csc, [
    "/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/warnaserror+",
    `/out:${path.join(bin, "Trip Planner Window.exe")}`,
    `/win32icon:${path.join(ROOT, "packaging", "icon.ico")}`,
    `/win32manifest:${path.join(ROOT, "packaging", "window", "app.manifest")}`,
    "/reference:System.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
    `/reference:${path.join(bin, "Microsoft.Web.WebView2.Core.dll")}`,
    `/reference:${path.join(bin, "Microsoft.Web.WebView2.WinForms.dll")}`,
    path.join(ROOT, "packaging", "window", "TripWindow.cs"),
  ], { stdio: "inherit" });
  return Object.fromEntries(fs.readdirSync(bin).map((f) => [f, path.join(bin, f)]));
}
