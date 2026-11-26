// `npm run dev` serves the app with hot reload and mounts the API (server/api.ts) into the same dev server,
// so one command runs everything on http://localhost:5173. Server files reload on save as well.
import fs from "node:fs";
import { type Plugin, defineConfig } from "vite";
import { readChangelog } from "./scripts/changelog.mjs";

function devApi(): Plugin {
  return {
    name: "trip-planner-api",
    configureServer(server) {
      let started = false;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const api = await server.ssrLoadModule("/server/api.ts");
          if (!started) { started = true; api.startup(); }
          await api.handleApi(req, res);
        } catch (e) { next(e); }
      });
    },
  };
}

/** "virtual:changelog": every version's changes, read from the git history when the page is built (Settings → Updates). */
function changelog(): Plugin {
  return {
    name: "trip-planner-changelog",
    resolveId: (id) => (id === "virtual:changelog" ? "\0virtual:changelog" : undefined),
    load: (id) => (id === "\0virtual:changelog" ? `export default ${JSON.stringify(readChangelog(import.meta.dirname))};` : undefined),
  };
}

const { version } = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [devApi(), changelog()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5173, strictPort: true },
  build: { outDir: "dist/web", emptyOutDir: true },
});
