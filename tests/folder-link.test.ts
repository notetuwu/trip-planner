// Telling what a pasted folder link or path is.
import { describe, expect, it } from "vitest";
import { classifyLink } from "../shared/folder-link";

describe("classifyLink", () => {
  it("finds a Google Drive folder in its share link or an old-style link", () => {
    expect(classifyLink("https://drive.google.com/drive/folders/1AbC-def_ghiJKL?usp=sharing")).toEqual({ kind: "drive", id: "1AbC-def_ghiJKL" });
    expect(classifyLink("https://drive.google.com/open?id=1AbC-def_ghiJKL")).toEqual({ kind: "drive", id: "1AbC-def_ghiJKL" });
  });
  it("takes paths on this computer and network drives, in quotes too", () => {
    expect(classifyLink('"D:\\Photos\\Japan"')).toEqual({ kind: "local", path: "D:\\Photos\\Japan" });
    expect(classifyLink("\\\\nas\\photos")).toEqual({ kind: "local", path: "\\\\nas\\photos" });
    expect(classifyLink("/Users/me/Pictures")).toEqual({ kind: "local", path: "/Users/me/Pictures" });
    expect(classifyLink("local:C:\\Trips")).toEqual({ kind: "local", path: "C:\\Trips" });
  });
  it("names other clouds' links, and knows nothing of anything else", () => {
    expect(classifyLink("https://1drv.ms/f/s!abc")).toEqual({ kind: "cloud", name: "OneDrive" });
    expect(classifyLink("https://www.dropbox.com/scl/fo/xyz/abc?rlkey=1")).toEqual({ kind: "dropbox", url: "https://www.dropbox.com/scl/fo/xyz/abc?rlkey=1" });
    expect(classifyLink("https://www.dropbox.com/s/abc/file.jpg")).toEqual({ kind: "cloud", name: "Dropbox" });
    expect(classifyLink("hello")).toEqual({ kind: "unknown" });
  });
});
