import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the Management UI (PR 29 / plan #131).
 *
 * Build emits to `packages/engine-self-operating/dist/ui/` so the
 * existing `static-ui.ts` middleware picks it up via the
 * `UI_DIST_PATH=packages/engine-self-operating/dist/ui` env var
 * (planner Q7).
 *
 * Dev server proxies `/api` to the engine's port (default 4001)
 * so the SPA can hit `/api/admin/*` without CORS during local
 * development.
 */
const ENGINE_DIST_UI = fileURLToPath(
  new URL("../engine-self-operating/dist/ui", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: ENGINE_DIST_UI,
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4001",
        changeOrigin: false,
      },
    },
  },
});
