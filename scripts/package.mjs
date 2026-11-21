// Packages the app for this computer's system as one executable file (Node's "single executable application"):
// the server and the built page are baked into a copy of Node, so nothing else needs installing.
//   npm run package  ->  release/  (Windows: portable zip + the exe for the installer; macOS: .app zip; Linux: tar.gz)
// Run `npm run build` first (npm run package does both).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const OUT = path.join(ROOT, "release"), WORK = path.join(OUT, "work");
const plat = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: WORK, ...opts });

if (!fs.existsSync(path.join(ROOT, "dist/web/index.html"))) throw new Error('No built page in dist/web: run "npm run build" first.');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// 1. The server and its dependencies as one CommonJS file (what Node's single executables run).
await esbuild.build({
  entryPoints: [path.join(ROOT, "server/main.ts")], outfile: path.join(WORK, "server.cjs"),
  bundle: true, platform: "node", format: "cjs", target: "node22", minify: true, logLevel: "warning",
  define: { __APP_VERSION__: JSON.stringify(version), "import.meta.dirname": "undefined" },
});

// 2. The built page goes in as assets, read back with node:sea's getAsset("web/...").
const assets = {};
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full);
    else assets[`web/${path.relative(path.join(ROOT, "dist/web"), full).split(path.sep).join("/")}`] = full;
  }
};
walk(path.join(ROOT, "dist/web"));
fs.writeFileSync(path.join(WORK, "sea-config.json"), JSON.stringify({
  main: "server.cjs", output: "sea.blob", disableExperimentalSEAWarning: true, useCodeCache: false, assets,
}, null, 2));
run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);

// 3. A copy of Node with the blob injected.
const exe = path.join(WORK, process.platform === "win32" ? "Trip Planner.exe" : "trip-planner");
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (process.platform === "win32") {
  // Icon and file details first (rcedit), then the blob.
  const { rcedit } = await import("rcedit");
  await rcedit(exe, {
    icon: path.join(ROOT, "packaging/icon.ico"), "file-version": version, "product-version": version,
    "version-string": { ProductName: "Trip Planner", FileDescription: "Trip Planner", CompanyName: "Trip Planner", LegalCopyright: "MIT License", OriginalFilename: "Trip Planner.exe" },
  });
}
if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
const { inject } = await import("postject");
await inject(exe, "NODE_SEA_BLOB", fs.readFileSync(path.join(WORK, "sea.blob")), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});

// 4. Wrap it up for the system.
const base = `Trip-Planner-${version}-${plat}-${arch}`;
const readme = (data) => `Trip Planner ${version}\n\nStart it by double-clicking it; it opens in its own window and quits when you close it.\n`
  + `${data}\nFor planning you need Claude Code (logged in), a local model server such as Ollama, or an API key (🔑 in the app).\n`
  + "More: https://github.com/notetuwu/trip-planner\n";

if (process.platform === "win32") {
  // No console window: mark the exe as a GUI program (PE header subsystem 3 -> 2).
  const buf = fs.readFileSync(exe), pe = buf.readUInt32LE(0x3c);
  buf.writeUInt16LE(2, pe + 4 + 20 + 68);
  fs.writeFileSync(exe, buf);
  // For the installer (packaging/trip-planner.iss).
  fs.mkdirSync(path.join(OUT, "win"), { recursive: true });
  fs.copyFileSync(exe, path.join(OUT, "win", "Trip Planner.exe"));
  // Portable: the "data" folder next to the exe makes it keep everything there.
  const dir = path.join(WORK, "portable", "Trip Planner");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.copyFileSync(exe, path.join(dir, "Trip Planner.exe"));
  fs.writeFileSync(path.join(dir, "README.txt"), readme("This is the portable version: your trips, lists and settings are kept in the \"data\" folder next to it, so you can move the whole folder (even to a USB stick).\n"));
  run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${dir}' -DestinationPath '${path.join(OUT, `${base}-portable.zip`)}' -Force`]);
} else if (process.platform === "darwin") {
  // A proper .app, so double-clicking doesn't open a Terminal.
  const app = path.join(WORK, "Trip Planner.app"), contents = path.join(app, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  fs.copyFileSync(exe, path.join(contents, "MacOS", "trip-planner"));
  const iconset = path.join(WORK, "icon.iconset");
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    run("sips", ["-z", String(s), String(s), path.join(ROOT, "packaging/icon.png"), "--out", path.join(iconset, `icon_${s}x${s}.png`)], { stdio: "ignore" });
  }
  run("iconutil", ["-c", "icns", iconset, "-o", path.join(contents, "Resources", "icon.icns")]);
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Trip Planner</string>
  <key>CFBundleDisplayName</key><string>Trip Planner</string>
  <key>CFBundleIdentifier</key><string>io.github.notetuwu.tripplanner</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>trip-planner</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>`);
  run("codesign", ["--force", "--deep", "--sign", "-", app]); // ad-hoc signature, required on Apple Silicon
  run("ditto", ["-c", "-k", "--keepParent", app, path.join(OUT, `${base}.zip`)]);
} else {
  const dir = path.join(WORK, "linux", "trip-planner"); // not WORK/trip-planner: that's the program itself
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(exe, path.join(dir, "trip-planner"));
  fs.chmodSync(path.join(dir, "trip-planner"), 0o755);
  fs.copyFileSync(path.join(ROOT, "packaging/icon.png"), path.join(dir, "icon.png"));
  fs.writeFileSync(path.join(dir, "README.txt"), readme("Your data is kept in ~/.local/share/trip-planner. To keep it next to the program instead (portable), create a folder named \"data\" here.\n"));
  run("tar", ["-czf", path.join(OUT, `${base}.tar.gz`), "-C", path.dirname(dir), "trip-planner"]);
}

console.log(`\nDone: ${fs.readdirSync(OUT).filter((f) => f !== "work").join(", ")} in release/`);
