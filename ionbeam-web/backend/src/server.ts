/**
 * Entry point for the Node proxy / static server.
 *
 *   /api/*        -> REST proxy onto FastAPI glasgow_service
 *   /ws/scan/...  -> WebSocket proxy (handled by attachWsProxy via http upgrade)
 *   /             -> serves frontend/dist when STATIC_DIR exists
 *
 * In MOCK=1 mode the REST handler short-circuits before the proxy and
 * returns synthetic ScanResult / status / defaults values that match the
 * Pydantic schemas the FastAPI service emits.
 */
import express from "express";
import morgan from "morgan";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

import { config } from "./config";
import { buildRestProxy } from "./restProxy";
import { attachWsProxy } from "./wsProxy";
import { mockRest } from "./mockHardware";

const app = express();

app.use(morgan("dev"));
app.use(express.json({ limit: "16mb" })); // vector custom up to 1M points

// Health endpoint for ops / load balancers.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    upstream: config.proxyTargetHttp,
    has_token: Boolean(config.glasgowToken),
  });
});

// MOCK responses live BEFORE the proxy mount so they win.
if (config.mock) {
  app.get("/api/status", (_req, res) => res.json(mockRest.status()));
  app.get("/api/defaults", (_req, res) => res.json(mockRest.defaults()));
  app.post("/api/scan/raster/run", (req, res) => res.json(mockRest.runRaster(req.body)));
  app.post("/api/scan/vector/run", (req, res) => res.json(mockRest.runVector(req.body)));
  app.post("/api/admin/reconnect", (_req, res) => res.json(mockRest.status()));

  // Last-scan downloads. The CSV is generated synthetically in-process;
  // the figure endpoint returns 501 because matplotlib only runs on the
  // Python side, and pulling in a Node image-rendering lib just for the
  // demo path would bloat the proxy. The real backend always serves
  // figures regardless of MOCK on the Node side.
  app.get("/api/scan/last/meta", (_req, res) => res.json(mockRest.lastMeta()));
  app.get("/api/scan/last/csv", (_req, res) => {
    const out = mockRest.lastCsv();
    if (!out) {
      res.status(404).json({ detail: "no scan data cached" });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.body);
  });
  app.get("/api/scan/last/figure", (_req, res) => {
    res.status(501).json({
      detail:
        "figure rendering is not available in MOCK=1 mode (matplotlib runs on the Python service only)",
    });
  });
} else {
  app.use("/api", buildRestProxy());
}

// Static (production) — only mount if the build output actually exists, so
// `npm run dev` doesn't 404 itself.
if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir));
  app.get("*", (_req, res, next) => {
    const indexHtml = path.join(config.staticDir, "index.html");
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else next();
  });
}

const server = http.createServer(app);
attachWsProxy(server);

server.listen(config.port, () => {
  console.log(
    `[ionbeam-web/backend] listening on :${config.port}\n` +
      `  mock     = ${config.mock}\n` +
      `  upstream = ${config.proxyTargetHttp}\n` +
      `  ws       = ${config.proxyTargetWs}\n` +
      `  token    = ${config.glasgowToken ? "set" : "(none)"}\n` +
      `  static   = ${fs.existsSync(config.staticDir) ? config.staticDir : "(not built yet)"}`
  );
});
