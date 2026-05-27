/**
 * REST proxy. Forwards /api/* to the FastAPI glasgow_service, injecting the
 * GLASGOW_TOKEN bearer header server-side so the browser never sees it.
 *
 * The path /api is stripped on the way upstream, so:
 *   GET /api/status           -> GET <PROXY_TARGET_HTTP>/status
 *   POST /api/scan/raster/run -> POST <PROXY_TARGET_HTTP>/scan/raster/run
 */
import { Router } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { config } from "./config";

export function buildRestProxy(): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    try {
      const upstream = await fetch(`${config.proxyTargetHttp}/status`, {
        headers: config.glasgowToken
          ? { Authorization: `Bearer ${config.glasgowToken}` }
          : undefined,
        signal: AbortSignal.timeout(2_000),
      });
      if (!upstream.ok) {
        throw new Error(`upstream status returned HTTP ${upstream.status}`);
      }
      res
        .status(upstream.status)
        .type(upstream.headers.get("content-type") ?? "application/json")
        .send(await upstream.text());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.json({
        state: "disconnected",
        last_error: `glasgow_service unreachable: ${detail}`,
        scans_completed: 0,
        chunks_in_flight: 0,
      });
    }
  });

  const proxy = createProxyMiddleware({
    target: config.proxyTargetHttp,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    on: {
      // Inject the bearer token if configured. Browsers must not see it.
      proxyReq: (proxyReq, req) => {
        if (config.glasgowToken) {
          proxyReq.setHeader("Authorization", `Bearer ${config.glasgowToken}`);
        }
        // body-parser may have already consumed the request body; re-write
        // it onto the proxied request so POST /scan/raster/run gets its JSON.
        fixRequestBody(proxyReq, req);
      },
      error: (err, _req, res) => {
        // Surface upstream-down failures as a clean JSON error rather than a
        // 502 with an HTML body.
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: "upstream_unreachable",
            detail: err.message,
            target: config.proxyTargetHttp,
          })
        );
      },
    },
  });

  router.use("/", proxy);
  return router;
}
