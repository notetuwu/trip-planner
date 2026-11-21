// Unit tests (npm test): pure logic of the server and the browser app, without a browser or network.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
