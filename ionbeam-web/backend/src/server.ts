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
import { spawn } from "node:child_process";

import { config } from "./config";
import { buildRestProxy } from "./restProxy";
import { attachWsProxy } from "./wsProxy";
import { mockRest } from "./mockHardware";
import {
  ConfigError,
  type RestartResult,
  readWithBackup,
  restartService,
  restoreFromBackup,
  writeConfig,
} from "./configManager";

const app = express();
let server: http.Server;

interface BackendRestartResult {
  ok: boolean;
  scheduled: boolean;
  mode: "disabled" | "exit" | "command";
  command?: string;
  error?: string;
}

interface RestartServicesResponse {
  ok: boolean;
  restart: RestartResult;
  backend_restart: BackendRestartResult;
}

app.use(morgan("dev"));
app.use(express.json({ limit: "16mb" })); // vector custom up to 1M points

// Health endpoint for ops / load balancers.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    upstream: config.proxyTargetHttp,
    has_token: Boolean(config.glasgowToken),
    config_path: config.configPath,
    restart_cmd: config.restartCmd,
    backend_restart_enabled: config.restartBackendAfterGlasgow,
    backend_restart_cmd: config.backendRestartCmd,
  });
});

app.get("/api/admin/config", async (_req, res) => {
  try {
    const info = await readWithBackup();
    res.json(info);
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/config", async (req, res) => {
  const data =
    req.body && typeof req.body === "object" && "data" in req.body
      ? (req.body as { data: unknown }).data
      : req.body;

  if (data === undefined || data === null) {
    res.status(400).json({
      ok: false,
      error: "missing JSON body: expected { data: <streamData> }",
    });
    return;
  }

  try {
    await writeConfig(data);
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  await restartServicesAndRespond(res);
});

app.post("/api/admin/config/restore", async (_req, res) => {
  try {
    await restoreFromBackup();
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  await restartServicesAndRespond(res);
});

app.post("/api/admin/restart-services", async (_req, res) => {
  await restartServicesAndRespond(res);
});

// MOCK responses live BEFORE the proxy mount so they win.
if (config.mock) {
  app.get("/api/status", (_req, res) => res.json(mockRest.status()));
  app.get("/api/defaults", (_req, res) => res.json(mockRest.defaults()));
  app.post("/api/scan/raster/run", (req, res) => res.json(mockRest.runRaster(req.body)));
  app.post("/api/scan/vector/run", (req, res) => res.json(mockRest.runVector(req.body)));

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

server = http.createServer(app);
attachWsProxy(server);

server.listen(config.port, () => {
  console.log(
    `[ionbeam-web/backend] listening on :${config.port}\n` +
      `  mock     = ${config.mock}\n` +
      `  upstream = ${config.proxyTargetHttp}\n` +
      `  ws       = ${config.proxyTargetWs}\n` +
      `  token    = ${config.glasgowToken ? "set" : "(none)"}\n` +
      `  config   = ${config.configPath}\n` +
      `  restart  = ${config.restartCmd}\n` +
      `  backend restart = ${
        config.restartBackendAfterGlasgow
          ? config.backendRestartCmd ?? "exit"
          : "disabled"
      }\n` +
      `  static   = ${fs.existsSync(config.staticDir) ? config.staticDir : "(not built yet)"}`
  );
});

function planBackendRestart(glasgowRestartOk: boolean): BackendRestartResult {
  if (!glasgowRestartOk) {
    return {
      ok: true,
      scheduled: false,
      mode: "disabled",
      error: "skipped because Glasgow service restart failed",
    };
  }
  if (!config.restartBackendAfterGlasgow) {
    return { ok: true, scheduled: false, mode: "disabled" };
  }
  if (config.backendRestartCmd) {
    return {
      ok: true,
      scheduled: true,
      mode: "command",
      command: config.backendRestartCmd,
    };
  }
  return { ok: true, scheduled: true, mode: "exit" };
}

async function restartServicesAndRespond(
  res: express.Response<RestartServicesResponse>
): Promise<void> {
  const restart = await restartService();
  const backendRestart = planBackendRestart(restart.ok);
  res.json({ ok: true, restart, backend_restart: backendRestart });
  scheduleBackendRestartAfterResponse(res, backendRestart);
}

function scheduleBackendRestartAfterResponse(
  res: express.Response,
  restart: BackendRestartResult
): void {
  if (!restart.scheduled) return;

  res.once("finish", () => {
    setTimeout(() => {
      restartBackend(restart);
    }, 250);
  });
}

function restartBackend(restart: BackendRestartResult): void {
  if (restart.mode === "command" && restart.command) {
    const child = spawn("bash", ["-lc", `sleep 1; exec ${restart.command}`], {
      detached: true,
      stdio: "ignore",
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
    });
    child.unref();
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 2_000).unref();
}

function sendConfigError(res: express.Response, err: unknown): void {
  if (err instanceof ConfigError) {
    res.status(err.status).json({ ok: false, error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ ok: false, error: message });
}
