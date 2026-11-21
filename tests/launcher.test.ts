import { describe, expect, it } from "vitest";
import { fillCommand } from "../server/launcher";

const url = "https://www.google.com/maps/search/?api=1&query=Hotel%20Krone%2C%20Lucerne";

describe("starting the default browser with a link", () => {
  it("fills in a Firefox-style command (Zen, Firefox)", () => {
    expect(fillCommand('"C:\Program Files\Zen Browser\zen.exe" -osint -url "%1"', url))
      .toEqual(["C:\Program Files\Zen Browser\zen.exe", ["-osint", "-url", url]]);
  });
  it("fills in a Chromium-style command (Edge, Chrome)", () => {
    expect(fillCommand('"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1', url))
      .toEqual(["C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", ["--single-argument", url]]);
  });
  it("adds the link when the command has no placeholder", () => {
    expect(fillCommand('"C:\b\browser.exe"', url)).toEqual(["C:\b\browser.exe", [url]]);
  });
});
