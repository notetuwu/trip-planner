// Live tests (npm run test:live): real models and services, never part of `npm test`. See tests/live/checked.live.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/live/**/*.live.ts"], environment: "node", testTimeout: 3 * 60 * 60_000 },
});
