/**
 * WebSocket proxy.
 *
 * Browser opens     ws://<this>/ws/scan/raster/stream
 * We connect to     ws://<glasgow>/scan/raster/stream  (with bearer in header)
 * and pipe frames in both directions. When the browser closes, we close
 * upstream — that triggers the FastAPI service's WebSocketDisconnect
 * handler, which calls gen.aclose() and cancels the in-flight scan
 * cleanly. That is the "stop" path.
 *
 * IMPORTANT — text vs binary:
 *   The 'ws' library's `message` event delivers data as Buffer regardless
 *   of frame type, and `ws.send(buffer)` defaults to BINARY. The FastAPI
 *   service uses `await ws.receive_json()`, which is Starlette's text-only
 *   helper (it does `message["text"]` and KeyErrors on binary frames). So
 *   we MUST forward the original isBinary flag in BOTH directions; without
 *   it the browser's JSON request reaches the service as binary and
 *   crashes, and the service's text replies (done/error events) reach the
 *   browser as ArrayBuffer and get painted as if they were pixel data.
 *
 * In MOCK=1 mode we never connect upstream; we synthesise frames in this
 * process instead.
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { config } from "./config";
import { streamMockRaster, streamMockVector, streamMockDacRamp } from "./mockHardware";
import { recordActivityInDb } from "./adminDbRepository";
import type { AdminUser } from "./adminDbRepository";
import { recordInputSetupInDb, recordOutputDataInDb } from "./operationDataRepository";
import { uploadScanArtifactsToConfiguredFtp } from "./ftpUpload";

type ScanKind = "raster" | "vector";
// "dac_ramp" is deliberately NOT part of ScanKind: it's a hardware
// diagnostic (single-axis DAC linearity check), not a real scan, so it's
// excluded from activity/FTP recording below exactly like "adc" is —
// see the `kind !== "adc"` guards.
type StreamKind = ScanKind | "adc" | "dac_ramp";
type RawData = Buffer | ArrayBuffer | Buffer[];
type ScanUpgradeAuthorization =
  | { ok: true; actor?: AdminUser }
  | { ok: false; status: number; message: string };
type ScanUpgradeAuthorize = (
  req: IncomingMessage,
) => Promise<ScanUpgradeAuthorization>;

const STREAM_PATHS: Record<string, StreamKind> = {
  "/ws/scan/raster/stream": "raster",
  "/ws/scan/vector/stream": "vector",
  "/ws/adc/stream": "adc",
  "/ws/scan/dac_ramp/stream": "dac_ramp",
};
const VECTOR_TRACE_LOG_FILE = path.join(os.tmpdir(), "ionbeam-vector-trace.log");

export function attachWsProxy(
  server: HttpServer,
  authorize?: ScanUpgradeAuthorize,
): void {
  // noServer: we drive the upgrade manually so we can route by path.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // Browsers can abort an upgrade while authorization is still pending.
    // Without an error listener, writing the rejection response to that
    // already-closed socket terminates Node with `Error: write EOF`.
    socket.on("error", () => undefined);
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const kind = STREAM_PATHS[url.pathname];
    if (!kind) {
      // Unknown WS endpoint — let the HTTP server reject it.
      socket.destroy();
      return;
    }

    void (async () => {
      const auth = authorize ? await authorize(req) : { ok: true as const };
      if (!auth.ok) {
        const statusText = auth.status === 403 ? "Forbidden" : "Scan authorization failed";
        if (!socket.destroyed && socket.writable) socket.write(
          `HTTP/1.1 ${auth.status} ${statusText}\r\n` +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Connection: close\r\n" +
            `Content-Length: ${Buffer.byteLength(auth.message)}\r\n\r\n` +
            auth.message,
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        if (config.mock) {
          handleMock(clientWs, kind, req, auth);
        } else {
          handleProxy(clientWs, kind, req, auth);
        }
      });
    })().catch((err) => {
      if (!socket.destroyed && socket.writable) socket.write(
        "HTTP/1.1 500 Internal Server Error\r\n" +
          "Connection: close\r\n" +
          `Content-Length: ${Buffer.byteLength(String(err))}\r\n\r\n` +
          String(err),
      );
      socket.destroy();
    });
  });
}

/* -------- real upstream pipe ------------------------------------------- */

function handleProxy(
  client: WebSocket,
  kind: StreamKind,
  req: IncomingMessage,
  auth: Extract<ScanUpgradeAuthorization, { ok: true }>,
): void {
  const upstreamUrl = kind === "adc"
    ? `${config.proxyTargetWs}/adc/stream`
    : `${config.proxyTargetWs}/scan/${kind}/stream`;
  // (dac_ramp falls through to the second branch: /scan/dac_ramp/stream,
  // matching the FastAPI route added in glasgow_service/api.py.)
  const headers: Record<string, string> = {};
  if (config.glasgowToken) {
    headers["Authorization"] = `Bearer ${config.glasgowToken}`;
  }

  const upstream = new WebSocket(upstreamUrl, { headers });
  const actor = auth.actor ?? null;
  let scanRequest: Record<string, unknown> | null = null;
  let previewScan = false;
  let activityIdPromise: Promise<number | null> | null = null;
  let completionHandled = false;
  let adcMockMode = false;

  // Buffer client frames sent before upstream is open. Almost always this
  // is just the first JSON request; bufferless drop loses scan params.
  // Tracked with isBinary so we can replay with the correct frame type.
  const earlyFrames: Array<{ data: RawData; isBinary: boolean }> = [];
  let upstreamOpen = false;

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary && scanRequest === null) {
      const parsed = parseJsonMessage(data);
      if (parsed) {
        scanRequest = parsed;
        previewScan = isPreviewScan(parsed);
        // Simulation is intentionally self-contained: do not require the
        // Glasgow service or build/program an FPGA image for test data.
        if (kind === "adc" && parsed.simulation === true) {
          adcMockMode = true;
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.close(1000, "ADC simulation handled by proxy");
          }
          void streamMockAdc(client, parsed).catch((err) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ event: "error", message: String(err) }), { binary: false });
              client.close(1011, "adc_simulation_error");
            }
          });
          return;
        }
        if (kind === "vector") {
          appendVectorTrace("request", {
            at: new Date().toISOString(),
            preview: previewScan,
            pattern: parsed.pattern ?? null,
            scan_path: parsed.scan_path ?? "vertical_raster",
            feedback_mode: parsed.feedback_mode ?? null,
            gray_level_range: parsed.gray_level_range ?? null,
            gray_level_skipped: parsed.gray_level_skipped ?? null,
            roi: parsed.roi != null,
            simulation_bitmap: parsed.simulation_bitmap != null,
          });
        }
        if (kind !== "adc" && kind !== "dac_ramp" && actor && !previewScan) {
          activityIdPromise = recordScanStart(kind, actor, parsed).catch((err) => {
            console.warn(`[operation-data] failed to record ${kind} scan start:`, err);
            return null;
          });
        }
      }
    }
    if (upstreamOpen) {
      upstream.send(data, { binary: isBinary });
    } else {
      earlyFrames.push({ data, isBinary });
    }
  });

  client.on("close", (code, reason) => {
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close(code === 1006 ? 1000 : code, reason);
    }
  });

  client.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const f of earlyFrames) upstream.send(f.data, { binary: f.isBinary });
    earlyFrames.length = 0;
  });

  upstream.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary && !completionHandled) {
      const parsed = parseJsonMessage(data);
      if (parsed?.event === "done") {
        completionHandled = true;
        if (kind === "adc" || kind === "dac_ramp") {
          // Diagnostic streams: relay "done" as-is, no activity/FTP
          // enrichment (same treatment as "adc" — see the ScanKind note
          // above StreamKind).
          if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: false });
          }
          return;
        }
        void recordAndMaybePersistScanCompletion(kind, scanRequest, activityIdPromise, parsed, !previewScan)
          .then((output) => {
            if (!output) return;
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  event: "done",
                  chunks: normalizeInteger(parsed.chunks, 0),
                  csv_filename: output.csvFilename,
                  image_filename: output.imageFilename,
                }),
                { binary: false },
              );
            }
          })
          .catch((err) => {
            console.warn(`[ftp-upload] failed to upload ${kind} scan artifacts:`, err);
          });
        return;
      }
    }
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  upstream.on("close", (code, reason) => {
    if (adcMockMode) return;
    if (
      client.readyState === WebSocket.OPEN ||
      client.readyState === WebSocket.CONNECTING
    ) {
      client.close(code === 1006 ? 1011 : code, reason);
    }
  });

  upstream.on("error", (err) => {
    if (adcMockMode) return;
    if (client.readyState === WebSocket.OPEN) {
      // Always send error metadata as a TEXT frame so the browser parses
      // it as JSON, not as pixels.
      client.send(
        JSON.stringify({
          event: "error",
          code: "upstream_unreachable",
          detail: err.message,
        }),
        { binary: false }
      );
      client.close(1011, "upstream_error");
    }
  });

  // Log the connect attempt for ops visibility; helpful when tracking down
  // 401s vs network errors vs the FastAPI being down.
  console.log(
    `[ws] ${req.socket.remoteAddress} -> ${upstreamUrl}` +
      (config.glasgowToken ? " (with bearer)" : "")
  );
}

function appendVectorTrace(
  kind: "request" | "response",
  payload: Record<string, unknown>,
): void {
  try {
    fs.appendFileSync(
      VECTOR_TRACE_LOG_FILE,
      `${JSON.stringify({ kind, ...payload })}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(`[ws][vector] failed to append trace to ${VECTOR_TRACE_LOG_FILE}:`, err);
  }
}

/* -------- MOCK=1 path -------------------------------------------------- */

function handleMock(
  client: WebSocket,
  kind: StreamKind,
  req: IncomingMessage,
  auth: Extract<ScanUpgradeAuthorization, { ok: true }>,
): void {
  console.log(`[ws][mock] ${req.socket.remoteAddress} -> ${kind} stream`);
  const actor = auth.actor ?? null;
  let activityIdPromise: Promise<number | null> | null = null;
  let scanRequest: Record<string, unknown> | null = null;
  let previewScan = false;
  client.once("message", async (raw: RawData) => {
    let body: any;
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      body = JSON.parse(text);
    } catch {
      client.send(JSON.stringify({ event: "error", code: "bad_json" }));
      client.close(1003, "bad json");
      return;
    }
    scanRequest = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    if (scanRequest) {
      previewScan = isPreviewScan(scanRequest);
      if (kind !== "adc" && kind !== "dac_ramp" && actor && !previewScan) {
        activityIdPromise = recordScanStart(kind, actor, scanRequest).catch((err) => {
          console.warn(`[operation-data] failed to record ${kind} scan start:`, err);
          return null;
        });
      }
    }
    try {
      if (kind === "adc") {
        await streamMockAdc(client, body);
      } else if (kind === "dac_ramp") {
        await streamMockDacRamp(client, {
          axis: body.axis === "y" ? "y" : "x",
          fixed_code: Number(body.fixed_code ?? 8192),
          dwell: Number(body.dwell ?? 500),
          latency_bytes: Number(body.latency_bytes ?? 16384),
        });
      } else if (kind === "raster") {
        await streamMockRaster(client, {
          resolution: Number(body.resolution ?? 256),
          dwell: Number(body.dwell ?? 16),
          latency_bytes: Number(body.latency_bytes ?? 16384),
          simulation_bitmap: body.simulation_bitmap ?? undefined,
          simulation: body.simulation && typeof body.simulation === "object" ? body.simulation : undefined,
          continuous: body.continuous === true,
        });
      } else {
        await streamMockVector(client, {
          pattern: body.pattern === "custom" ? "custom" : "default",
          scan_path: normalizeVectorScanPath(body.scan_path),
          points: Array.isArray(body.points) ? body.points : undefined,
          dwell: Number(body.dwell ?? 16),
          latency_bytes: Number(body.latency_bytes ?? 8196),
          roi: body.roi ?? undefined,
          simulation_bitmap: body.simulation_bitmap ?? undefined,
          simulation: body.simulation && typeof body.simulation === "object" ? body.simulation : undefined,
          vector_resolution: body.vector_resolution
            ? Number(body.vector_resolution)
            : undefined,
          continuous: body.continuous === true,
        });
      }
    } catch (e: any) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ event: "error", message: String(e) }));
      }
    } finally {
      if (kind !== "adc" && kind !== "dac_ramp" && scanRequest) {
        void recordAndMaybePersistScanCompletion(
          kind,
          scanRequest,
          activityIdPromise,
          { event: "done", chunks: 0 },
          !previewScan,
        ).catch((err) => {
          console.warn(`[ftp-upload] failed to finalize ${kind} scan artifacts:`, err);
        });
      }
      if (client.readyState === WebSocket.OPEN) client.close(1000);
    }
  });
}

async function streamMockAdc(client: WebSocket, body: any): Promise<void> {
  const durationMinutes = [5, 10, 15, 20].includes(Number(body.duration_minutes))
    ? Number(body.duration_minutes)
    : 5;
  let state = Math.max(1, Number(body.seed) & 0x3fff);
  client.send(JSON.stringify({
    event: "metadata",
    duration_minutes: durationMinutes,
    simulation: true,
    sample_bits: 14,
    wire_format: "uint16-be",
  }), { binary: false });
  const deadline = Date.now() + durationMinutes * 60_000;
  let chunks = 0;
  let level = state;
  while (client.readyState === WebSocket.OPEN && Date.now() < deadline) {
    const samples = 4096;
    const chunk = Buffer.allocUnsafe(samples * 2);
    // Move the simulated signal between levels once per chunk, then add
    // bounded sample noise. This keeps the displayed time bins visibly
    // randomized instead of averaging uniform LFSR samples to mid-gray.
    const levelFeedback = ((state >> 13) ^ (state >> 12)) & 1;
    state = ((state << 1) & 0x3fff) | levelFeedback;
    level = state;
    for (let index = 0; index < samples; index += 1) {
      const feedback = ((state >> 13) ^ (state >> 12)) & 1;
      state = ((state << 1) & 0x3fff) | feedback;
      const noise = ((state & 0xff) - 128) * 8;
      chunk.writeUInt16BE(Math.max(0, Math.min(0x3fff, level + noise)), index * 2);
    }
    client.send(chunk, { binary: true });
    chunks += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify({ event: "done", chunks }), { binary: false });
  }
}

async function recordScanStart(
  kind: ScanKind,
  actor: AdminUser,
  body: Record<string, unknown>,
): Promise<number | null> {
  const activityId = await recordActivityInDb(
    Number(actor.id ?? 0),
    null,
    `${kind}_scan`,
    Math.max(1, Math.trunc(actor.session_lifetime_limit_days ?? 1)),
  );
  if (!activityId) {
    return null;
  }

  await recordInputSetupInDb({
    activity_id: activityId,
    start_xy: normalizeDecimal(body.start_xy, 0),
    end_xy: normalizeDecimal(body.end_xy, 0),
    dwell: normalizeInteger(body.dwell, 16),
    scale_unit: normalizeScaleUnit(body.scale_unit),
    ev: normalizeDecimal(body.ev, 0),
    scan_parameters: body,
  });
  return activityId;
}

async function recordAndMaybePersistScanCompletion(
  kind: ScanKind,
  requestBody: Record<string, unknown> | null,
  activityIdPromise: Promise<number | null> | null,
  response: Record<string, unknown>,
  persist: boolean,
): Promise<{ csvFilename: string; imageFilename: string } | null> {
  const activityId = activityIdPromise ? await activityIdPromise : null;
  const chunks = normalizeInteger(response.chunks, 0);
  const output = buildScanArtifactInfo(kind, activityId, requestBody, response, chunks);
  if (persist && activityId) {
    await recordOutputDataInDb({
      activity_id: activityId,
      csv_filename: output.csvFilename,
      image_filename: output.imageFilename,
      description: output.description,
      scan_result: response,
    });
    void uploadScanArtifactsToConfiguredFtp(kind, {
      csvFilename: output.csvFilename,
      imageFilename: output.imageFilename,
    }, !persist).catch((err) => {
      console.warn(`[ftp-upload] failed to upload ${kind} scan artifacts:`, err);
    });
  }
  return {
    csvFilename: output.csvFilename,
    imageFilename: output.imageFilename,
  };
}

function buildScanArtifactInfo(
  kind: ScanKind,
  activityId: number | null,
  body: Record<string, unknown> | null,
  response: Record<string, unknown>,
  chunks: number,
): { csvFilename: string; imageFilename: string; description: string } {
  const timestamp = formatScanTimestamp(new Date());
  const resolution = normalizeInteger(response.resolution ?? body?.resolution, 0);
  const latencyBytes = normalizeInteger(response.latency_bytes ?? body?.latency_bytes, 0);
  const vectorResolution = normalizeInteger(response.vector_resolution ?? body?.vector_resolution, 0);
  const filenames = buildScanArtifactFilenames(kind, resolution, latencyBytes, vectorResolution, timestamp);
  return {
    ...filenames,
    description: JSON.stringify({
      kind,
      activity_id: activityId,
      chunks,
      resolution: resolution || null,
      latency_bytes: latencyBytes || null,
      vector_resolution: vectorResolution || null,
      csv_filename: filenames.csvFilename,
      image_filename: filenames.imageFilename,
    }),
  };
}

function isPreviewScan(body: Record<string, unknown> | null): boolean {
  const value = body?.preview;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "on"].includes(normalized);
  }
  return false;
}

function buildScanArtifactFilenames(
  kind: ScanKind,
  resolution: number,
  latencyBytes: number,
  vectorResolution: number,
  timestamp: string,
): { csvFilename: string; imageFilename: string } {
  return kind === "raster"
    ? {
        csvFilename: `raster_${resolution}x${resolution}_${timestamp}.csv`,
        imageFilename: `raster_${resolution}x${resolution}_${timestamp}.png`,
      }
    : {
        csvFilename: `vector_latency_${latencyBytes || vectorResolution || 0}_${timestamp}.csv`,
        imageFilename: `vector_latency_${latencyBytes || vectorResolution || 0}_${timestamp}.png`,
      };
}

function formatScanTimestamp(date: Date): string {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}

function normalizeInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeDecimal(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeScaleUnit(value: unknown): string {
  const unit = String(value ?? "").trim();
  return unit.slice(0, 10) || "dac";
}

function normalizeVectorScanPath(value: unknown):
  | "vertical_raster"
  | "vertical_serpentine"
  | "horizontal_sawtooth"
  | "horizontal_triangle" {
  const path = String(value ?? "vertical_raster");
  switch (path) {
    case "vertical_serpentine":
    case "horizontal_sawtooth":
    case "horizontal_triangle":
      return path;
    default:
      return "vertical_raster";
  }
}

function parseJsonMessage(data: RawData): Record<string, unknown> | null {
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
