// The Windows app's own window needs the WebView2 runtime; without it a browser window opens instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webViewInstalled } from "../server/window-host";

let root = "";
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "webview-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("finding the WebView2 runtime", () => {
  const version = () => path.join(root, "Microsoft", "EdgeWebView", "Application", "158.0.1.2");

  it("finds an installed version", () => {
    fs.mkdirSync(version(), { recursive: true });
    fs.writeFileSync(path.join(version(), "msedgewebview2.exe"), "");
    expect(webViewInstalled({ "ProgramFiles(x86)": root })).toBe(true);
  });
  it("isn't fooled by a folder left behind", () => {
    fs.mkdirSync(version(), { recursive: true });
    expect(webViewInstalled({ "ProgramFiles(x86)": root, LOCALAPPDATA: root })).toBe(false);
    expect(webViewInstalled({})).toBe(false);
  });
});
