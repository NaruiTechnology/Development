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
import { initializeSbcVacuum, readEffectiveVacuumEnabled, readInitialSbcVacuumStatus, retrySbcVacuumInitialization } from "./vacuumConfig";

/** Host setting AND the SBC's own report (see vacuumConfig.ts). */
const effectiveVacuumEnabled = () => readEffectiveVacuumEnabled(
  config.vacuumConfigPath, config.vacuumControllerUrl, config.sbcVacuumToken);

// Establish availability once when the host backend starts. No runtime poll or
// control request is sent to the standalone SBC after this initialization.
void initializeSbcVacuum(config.vacuumControllerUrl, config.sbcVacuumToken);

export function buildRestProxy(): Router {
  const router = Router();
  type RoutedRequest = {
    url?: string;
    originalUrl?: string;
    sampleStageProxyTarget?: boolean;
  };
  const isSampleStageRequest = (req: RoutedRequest): boolean =>
    req.sampleStageProxyTarget === true ||
    req.url?.startsWith("/stage") === true ||
    req.originalUrl?.startsWith("/api/stage") === true;
  router.get("/status", async (_req, res) => {
    const vacuumEnabled = await effectiveVacuumEnabled();
    try {
      const upstream = await fetch(`${config.proxyTargetHttp}/status`, {
        headers: config.glasgowToken
          ? { Authorization: `Bearer ${config.glasgowToken}` }
          : undefined,
        signal: AbortSignal.timeout(2_000),
      });
      const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
      const text = await upstream.text();
      if (!upstream.ok) {
        throw new Error(`upstream status returned HTTP ${upstream.status}`);
      }
      if (!contentType.includes("application/json")) {
        res.status(502).json({
          error: "upstream_invalid_content_type",
          detail: `upstream /status returned ${contentType || "unknown content type"} instead of JSON`,
          upstream_status: upstream.status,
        });
        return;
      }
      try {
        const status = JSON.parse(text) as { vacuum_enabled?: unknown };
        status.vacuum_enabled = vacuumEnabled;
        res.status(upstream.status).json(status);
      } catch {
        res.status(502).json({
          error: "upstream_invalid_json",
          detail: "upstream /status returned invalid JSON",
          upstream_status: upstream.status,
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      res.json({
        state: "disconnected",
        last_error: `glasgow_service unreachable: ${detail}`,
        scans_completed: 0,
        chunks_in_flight: 0,
        vacuum_enabled: vacuumEnabled,
      });
    }
  });

  router.get("/vacuum", async (_req, res) => {
    if (!await effectiveVacuumEnabled()) {
      res.status(404).json({ detail: "vacuum controller is unavailable or disabled" });
      return;
    }
    const status = await readInitialSbcVacuumStatus(config.vacuumControllerUrl, config.sbcVacuumToken);
    if (!status) {
      res.status(503).json({ detail: "SBC vacuum controller was unavailable during host initialization" });
      return;
    }
    res.json(status);
  });
  router.post("/vacuum/initialize", async (_req, res) => {
    if (!await effectiveVacuumEnabled()) {
      res.status(404).json({ detail: "vacuum controller is unavailable or disabled" });
      return;
    }
    const initialized = await retrySbcVacuumInitialization(config.vacuumControllerUrl, config.sbcVacuumToken);
    if (!initialized?.status) {
      res.status(initialized?.value === false ? 404 : 503).json({ detail: "SBC vacuum controller is still unavailable" });
      return;
    }
    res.json(initialized.status);
  });
  router.use("/vacuum", (_req, res) => {
    res.status(409).json({ detail: "SBC vacuum control is standalone; runtime commands are disabled in this app" });
  });

  router.use("/stage", (req, _res, next) => {
    (req as RoutedRequest).sampleStageProxyTarget = true;
    next();
  });

  const proxy = createProxyMiddleware({
    target: config.proxyTargetHttp,
    router: (req) => isSampleStageRequest(req)
      ? config.sampleStageControllerUrl
      : config.proxyTargetHttp,
    changeOrigin: true,
    pathRewrite: { "^/api": "" },
    selfHandleResponse: true,
    on: {
      // Inject the bearer token if configured. Browsers must not see it.
      proxyReq: (proxyReq, req) => {
        const token = config.glasgowToken;
        if (token) {
          proxyReq.setHeader("Authorization", `Bearer ${token}`);
        }
        // body-parser may have already consumed the request body; re-write
        // it onto the proxied request so POST /scan/raster/run gets its JSON.
        fixRequestBody(proxyReq, req);
      },
      proxyRes: (proxyRes, req, res) => {
        const contentType = String(proxyRes.headers["content-type"] ?? "").toLowerCase();
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks);
          const statusCode = proxyRes.statusCode ?? 502;
          const headers = Object.fromEntries(
            Object.entries(proxyRes.headers).filter(([name]) => {
              const lower = name.toLowerCase();
              return lower !== "content-length" && lower !== "transfer-encoding";
            })
          );
          const targetUrl = `${req.method} ${req.url ?? "/api"}`;

          if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "upstream_invalid_content_type",
                  detail: `upstream ${targetUrl} returned ${contentType || "unknown content type"}`,
                  upstream_status: statusCode,
                })
              );
            }
            return;
          }

          if (!res.headersSent) {
            res.writeHead(statusCode, headers as Record<string, string | string[]>);
            res.end(body);
          }
        });
      },
      error: (err, req, res) => {
        // Surface upstream-down failures as a clean JSON error rather than a
        // 502 with an HTML body.
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: "upstream_unreachable",
            detail: err.message,
            target: isSampleStageRequest(req)
                ? config.sampleStageControllerUrl
                : config.proxyTargetHttp,
          })
        );
      },
    },
  });

  router.use("/", proxy);
  return router;
}
