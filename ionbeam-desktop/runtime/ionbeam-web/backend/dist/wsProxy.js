"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachWsProxy = attachWsProxy;
exports.handleMock = handleMock;
exports.recordScanStart = recordScanStart;
exports.recordAndMaybePersistScanCompletion = recordAndMaybePersistScanCompletion;
exports.isPreviewScan = isPreviewScan;
const node_fs_1 = __importDefault(require("node:fs"));
const ws_1 = require("ws");
const node_url_1 = require("node:url");
const node_buffer_1 = require("node:buffer");
const config_1 = require("./config");
const mockHardware_1 = require("./mockHardware");
const adminDbRepository_1 = require("./adminDbRepository");
const operationDataRepository_1 = require("./operationDataRepository");
const ftpUpload_1 = require("./ftpUpload");
const STREAM_PATHS = {
    "/ws/scan/raster/stream": "raster",
    "/ws/scan/vector/stream": "vector",
    "/ws/adc/stream": "adc",
    "/ws/scan/dac_ramp/stream": "dac_ramp",
};
const VECTOR_TRACE_LOG_FILE = "/tmp/ionbeam-vector-trace.log";
function attachWsProxy(server, authorize) {
    // noServer: we drive the upgrade manually so we can route by path.
    const wss = new ws_1.WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        if (!req.url) {
            socket.destroy();
            return;
        }
        const url = new node_url_1.URL(req.url, "http://localhost");
        const kind = STREAM_PATHS[url.pathname];
        if (!kind) {
            // Unknown WS endpoint — let the HTTP server reject it.
            socket.destroy();
            return;
        }
        void (async () => {
            const auth = authorize ? await authorize(req) : { ok: true };
            if (!auth.ok) {
                const statusText = auth.status === 403 ? "Forbidden" : "Scan authorization failed";
                socket.write(`HTTP/1.1 ${auth.status} ${statusText}\r\n` +
                    "Content-Type: text/plain; charset=utf-8\r\n" +
                    "Connection: close\r\n" +
                    `Content-Length: ${node_buffer_1.Buffer.byteLength(auth.message)}\r\n\r\n` +
                    auth.message);
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (clientWs) => {
                if (config_1.config.mock) {
                    handleMock(clientWs, kind, req, auth);
                }
                else {
                    handleProxy(clientWs, kind, req, auth);
                }
            });
        })().catch((err) => {
            socket.write("HTTP/1.1 500 Internal Server Error\r\n" +
                "Connection: close\r\n" +
                `Content-Length: ${node_buffer_1.Buffer.byteLength(String(err))}\r\n\r\n` +
                String(err));
            socket.destroy();
        });
    });
}
/* -------- real upstream pipe ------------------------------------------- */
function handleProxy(client, kind, req, auth) {
    const upstreamUrl = kind === "adc"
        ? `${config_1.config.proxyTargetWs}/adc/stream`
        : `${config_1.config.proxyTargetWs}/scan/${kind}/stream`;
    // (dac_ramp falls through to the second branch: /scan/dac_ramp/stream,
    // matching the FastAPI route added in glasgow_service/api.py.)
    const headers = {};
    if (config_1.config.glasgowToken) {
        headers["Authorization"] = `Bearer ${config_1.config.glasgowToken}`;
    }
    const upstream = new ws_1.WebSocket(upstreamUrl, { headers });
    const actor = auth.actor ?? null;
    let scanRequest = null;
    let previewScan = false;
    let activityIdPromise = null;
    let completionHandled = false;
    let adcMockMode = false;
    // Buffer client frames sent before upstream is open. Almost always this
    // is just the first JSON request; bufferless drop loses scan params.
    // Tracked with isBinary so we can replay with the correct frame type.
    const earlyFrames = [];
    let upstreamOpen = false;
    client.on("message", (data, isBinary) => {
        if (!isBinary && scanRequest === null) {
            const parsed = parseJsonMessage(data);
            if (parsed) {
                scanRequest = parsed;
                previewScan = isPreviewScan(parsed);
                // Simulation is intentionally self-contained: do not require the
                // Glasgow service or build/program an FPGA image for test data.
                if (kind === "adc" && parsed.simulation === true) {
                    adcMockMode = true;
                    if (upstream.readyState === ws_1.WebSocket.OPEN || upstream.readyState === ws_1.WebSocket.CONNECTING) {
                        upstream.close(1000, "ADC simulation handled by proxy");
                    }
                    void streamMockAdc(client, parsed).catch((err) => {
                        if (client.readyState === ws_1.WebSocket.OPEN) {
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
        }
        else {
            earlyFrames.push({ data, isBinary });
        }
    });
    client.on("close", (code, reason) => {
        if (upstream.readyState === ws_1.WebSocket.OPEN ||
            upstream.readyState === ws_1.WebSocket.CONNECTING) {
            upstream.close(code === 1006 ? 1000 : code, reason);
        }
    });
    client.on("error", () => {
        if (upstream.readyState === ws_1.WebSocket.OPEN)
            upstream.close();
    });
    upstream.on("open", () => {
        upstreamOpen = true;
        for (const f of earlyFrames)
            upstream.send(f.data, { binary: f.isBinary });
        earlyFrames.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
        if (!isBinary && !completionHandled) {
            const parsed = parseJsonMessage(data);
            if (parsed?.event === "done") {
                completionHandled = true;
                if (kind === "adc" || kind === "dac_ramp") {
                    // Diagnostic streams: relay "done" as-is, no activity/FTP
                    // enrichment (same treatment as "adc" — see the ScanKind note
                    // above StreamKind).
                    if (client.readyState === ws_1.WebSocket.OPEN) {
                        client.send(data, { binary: false });
                    }
                    return;
                }
                void recordAndMaybePersistScanCompletion(kind, scanRequest, activityIdPromise, parsed, !previewScan)
                    .then((output) => {
                    if (!output)
                        return;
                    if (client.readyState === ws_1.WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            event: "done",
                            chunks: normalizeInteger(parsed.chunks, 0),
                            csv_filename: output.csvFilename,
                            image_filename: output.imageFilename,
                        }), { binary: false });
                    }
                })
                    .catch((err) => {
                    console.warn(`[ftp-upload] failed to upload ${kind} scan artifacts:`, err);
                });
                return;
            }
        }
        if (client.readyState === ws_1.WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
        }
    });
    upstream.on("close", (code, reason) => {
        if (adcMockMode)
            return;
        if (client.readyState === ws_1.WebSocket.OPEN ||
            client.readyState === ws_1.WebSocket.CONNECTING) {
            client.close(code === 1006 ? 1011 : code, reason);
        }
    });
    upstream.on("error", (err) => {
        if (adcMockMode)
            return;
        if (client.readyState === ws_1.WebSocket.OPEN) {
            // Always send error metadata as a TEXT frame so the browser parses
            // it as JSON, not as pixels.
            client.send(JSON.stringify({
                event: "error",
                code: "upstream_unreachable",
                detail: err.message,
            }), { binary: false });
            client.close(1011, "upstream_error");
        }
    });
    // Log the connect attempt for ops visibility; helpful when tracking down
    // 401s vs network errors vs the FastAPI being down.
    console.log(`[ws] ${req.socket.remoteAddress} -> ${upstreamUrl}` +
        (config_1.config.glasgowToken ? " (with bearer)" : ""));
}
function appendVectorTrace(kind, payload) {
    try {
        node_fs_1.default.appendFileSync(VECTOR_TRACE_LOG_FILE, `${JSON.stringify({ kind, ...payload })}\n`, "utf8");
    }
    catch (err) {
        console.warn(`[ws][vector] failed to append trace to ${VECTOR_TRACE_LOG_FILE}:`, err);
    }
}
/* -------- MOCK=1 path -------------------------------------------------- */
function handleMock(client, kind, req, auth) {
    console.log(`[ws][mock] ${req.socket.remoteAddress} -> ${kind} stream`);
    const actor = auth.actor ?? null;
    let activityIdPromise = null;
    let scanRequest = null;
    let previewScan = false;
    client.once("message", async (raw) => {
        let body;
        try {
            const text = node_buffer_1.Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
            body = JSON.parse(text);
        }
        catch {
            client.send(JSON.stringify({ event: "error", code: "bad_json" }));
            client.close(1003, "bad json");
            return;
        }
        scanRequest = body && typeof body === "object" ? body : null;
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
            }
            else if (kind === "dac_ramp") {
                await (0, mockHardware_1.streamMockDacRamp)(client, {
                    axis: body.axis === "y" ? "y" : "x",
                    fixed_code: Number(body.fixed_code ?? 8192),
                    dwell: Number(body.dwell ?? 500),
                    latency_bytes: Number(body.latency_bytes ?? 16384),
                });
            }
            else if (kind === "raster") {
                await (0, mockHardware_1.streamMockRaster)(client, {
                    resolution: Number(body.resolution ?? 256),
                    dwell: Number(body.dwell ?? 16),
                    latency_bytes: Number(body.latency_bytes ?? 16384),
                    simulation_bitmap: body.simulation_bitmap ?? undefined,
                });
            }
            else {
                await (0, mockHardware_1.streamMockVector)(client, {
                    pattern: body.pattern === "custom" ? "custom" : "default",
                    scan_path: normalizeVectorScanPath(body.scan_path),
                    points: Array.isArray(body.points) ? body.points : undefined,
                    dwell: Number(body.dwell ?? 16),
                    latency_bytes: Number(body.latency_bytes ?? 8196),
                    roi: body.roi ?? undefined,
                    simulation_bitmap: body.simulation_bitmap ?? undefined,
                    vector_resolution: body.vector_resolution
                        ? Number(body.vector_resolution)
                        : undefined,
                });
            }
        }
        catch (e) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(JSON.stringify({ event: "error", message: String(e) }));
            }
        }
        finally {
            if (kind !== "adc" && kind !== "dac_ramp" && scanRequest) {
                void recordAndMaybePersistScanCompletion(kind, scanRequest, activityIdPromise, { event: "done", chunks: 0 }, !previewScan).catch((err) => {
                    console.warn(`[ftp-upload] failed to finalize ${kind} scan artifacts:`, err);
                });
            }
            if (client.readyState === ws_1.WebSocket.OPEN)
                client.close(1000);
        }
    });
}
async function streamMockAdc(client, body) {
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
    while (client.readyState === ws_1.WebSocket.OPEN && Date.now() < deadline) {
        const samples = 4096;
        const chunk = node_buffer_1.Buffer.allocUnsafe(samples * 2);
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
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (client.readyState === ws_1.WebSocket.OPEN) {
        client.send(JSON.stringify({ event: "done", chunks }), { binary: false });
    }
}
async function recordScanStart(kind, actor, body) {
    const activityId = await (0, adminDbRepository_1.recordActivityInDb)(Number(actor.id ?? 0), null, `${kind}_scan`, Math.max(1, Math.trunc(actor.session_lifetime_limit_days ?? 1)));
    if (!activityId) {
        return null;
    }
    await (0, operationDataRepository_1.recordInputSetupInDb)({
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
async function recordAndMaybePersistScanCompletion(kind, requestBody, activityIdPromise, response, persist) {
    const activityId = activityIdPromise ? await activityIdPromise : null;
    const chunks = normalizeInteger(response.chunks, 0);
    const output = buildScanArtifactInfo(kind, activityId, requestBody, response, chunks);
    if (persist && activityId) {
        await (0, operationDataRepository_1.recordOutputDataInDb)({
            activity_id: activityId,
            csv_filename: output.csvFilename,
            image_filename: output.imageFilename,
            description: output.description,
            scan_result: response,
        });
        void (0, ftpUpload_1.uploadScanArtifactsToConfiguredFtp)(kind, {
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
function buildScanArtifactInfo(kind, activityId, body, response, chunks) {
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
function isPreviewScan(body) {
    const value = body?.preview;
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return ["true", "1", "yes", "on"].includes(normalized);
    }
    return false;
}
function buildScanArtifactFilenames(kind, resolution, latencyBytes, vectorResolution, timestamp) {
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
function formatScanTimestamp(date) {
    const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const min = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");
    return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}
function normalizeInteger(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function normalizeDecimal(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function normalizeScaleUnit(value) {
    const unit = String(value ?? "").trim();
    return unit.slice(0, 10) || "dac";
}
function normalizeVectorScanPath(value) {
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
function parseJsonMessage(data) {
    try {
        const text = node_buffer_1.Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
                ? node_buffer_1.Buffer.concat(data).toString("utf8")
                : node_buffer_1.Buffer.from(data).toString("utf8");
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=wsProxy.js.map