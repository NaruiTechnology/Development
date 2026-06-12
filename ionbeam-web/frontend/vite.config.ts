import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Vite server proxies /api and /ws to the Node backend on
// :4000. The Node backend in turn proxies to the FastAPI glasgow_service.
// Two hops in dev is intentional — it exercises the same code path
// production traffic takes, so MOCK toggling and bearer injection stay
// in scope.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTargetHttp = env.VITE_PROXY_TARGET_HTTP || "http://127.0.0.1:4000";
  const proxyTargetWs = env.VITE_PROXY_TARGET_WS || "ws://127.0.0.1:4000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      allowedHosts: ["localhost", "ion.o-0.top"],
      proxy: {
        "/api": {
          target: proxyTargetHttp,
          changeOrigin: true,
        },
        "/ws": {
          target: proxyTargetWs,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
