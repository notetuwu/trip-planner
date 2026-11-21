import { describe, expect, it } from "vitest";
import { refuse } from "../server/util/guard";

const req = (headers: Record<string, string>, method = "POST") => ({ method, headers }) as any;

describe("API guard", () => {
  it("answers the planner's own page", () => {
    expect(refuse(req({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBeNull();
    expect(refuse(req({ host: "127.0.0.1:5199" }))).toBeNull();
  });
  it("refuses other websites and foreign hosts", () => {
    expect(refuse(req({ host: "localhost:5173", origin: "https://evil.example" }))).toBeTruthy();
    expect(refuse(req({ host: "evil.example:5173" }))).toBeTruthy();
    expect(refuse(req({ host: "localhost:5173", origin: "null" }))).toBeTruthy();
    expect(refuse(req({ host: "localhost:5173", origin: "null" }, "GET"))).toBeNull();
  });
});
