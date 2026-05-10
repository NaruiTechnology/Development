import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Vite server proxies /api and /ws to the Node backend on
// :4000. The Node backend in turn proxies to the FastAPI glasgow_service.
// Two hops in dev is intentional — it exercises the same code path
// production traffic takes, so MOCK toggling and bearer injection stay
// in scope.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:4000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
