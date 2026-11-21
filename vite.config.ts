// `npm run dev` serves the app with hot reload and mounts the API (server/api.ts) into the same dev server,
// so one command runs everything on http://localhost:5173. Server files reload on save as well.
import { type Plugin, defineConfig } from "vite";

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

export default defineConfig({
  plugins: [devApi()],
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 5173, strictPort: true },
  build: { outDir: "dist/web", emptyOutDir: true },
});
