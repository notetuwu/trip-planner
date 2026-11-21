// Runs vitest. On Windows a terminal opened at "c:\..." (lowercase drive letter, as VS Code often does) makes vitest
// load itself twice and every test fails, so start it from the same folder spelled with an uppercase drive letter.
import { spawnSync } from "node:child_process";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(run.status ?? 1);
