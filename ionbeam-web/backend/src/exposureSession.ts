import { WebSocket } from "ws";
import {randomUUID} from "node:crypto";
import { config } from "./config";

/** One authenticated browser connection for a run. Requests are strictly serial;
 * losing either connection ends the session and never replays a segment. */
export function handleExposureSession(client: WebSocket): void {
  const sessionId = randomUUID();
  const startedAt = Date.now();
  let segments = 0, bytes = 0;
  let upstream: WebSocket | null = null;
  let done: string | null = null;
  let alive = true;
  const fail = (detail: string) => {
    console.warn("[exposure-session] failed", {sessionId, segments, bytes, elapsedMs: Date.now() - startedAt, detail});
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({event: "error", detail}));
      client.close(1011, "exposure-session-failed");
    }
    upstream?.terminate();
  };
  // Transport liveness is distinct from acquisition progress. A responsive
  // browser must still enforce its dwell-aware acquisition deadline.
  const heartbeat = setInterval(() => {
    if (!alive) { client.terminate(); return; }
    alive = false;
    client.ping();
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({event: "heartbeat"}));
  }, 10_000);
  heartbeat.unref();
  client.on("pong", () => { alive = true; });
  client.on("close", () => {
    clearInterval(heartbeat); upstream?.terminate();
    console.info("[exposure-session] closed", {sessionId, segments, bytes, elapsedMs: Date.now() - startedAt});
  });
  client.on("error", () => { clearInterval(heartbeat); upstream?.terminate(); });
  client.on("message", (raw, binary) => {
    if (upstream) { fail("Exposure session received overlapping requests"); return; }
    let envelope;
    try { if (binary) throw new Error(); envelope = JSON.parse(raw.toString()); }
    catch { fail("Invalid exposure request"); return; }
    const {kind, request} = envelope ?? {};
    if (!request || request.continuous === true ||
        !(kind === "vector" && request.pattern === "lattice" ||
          kind === "raster" && request.exposure_view === true)) {
      fail("Exposure session accepts finite lattice exposures and View frames only"); return;
    }
    done = null;
    segments++;
    const source = new WebSocket(`${config.proxyTargetWs}/scan/${kind}/stream`, {
      headers: config.glasgowToken ? {Authorization: `Bearer ${config.glasgowToken}`} : {},
      handshakeTimeout: 15_000,
    });
    upstream = source;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    source.on("open", () => {
      if (client.readyState !== WebSocket.OPEN) { source.terminate(); return; }
      source.send(JSON.stringify(request));
    });
    source.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (isBinary) bytes += Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.length, 0) : data.byteLength;
      if (!isBinary) {
        let message;
        try { message = JSON.parse(data.toString()); }
        catch { fail("Invalid exposure service response"); return; }
        if (message.event === "done") {
          done = data.toString();
          // The service sends done after the generator releases the device.
          // Closing it here also bounds a service that forgets its close frame.
          source.close(1000, "exposure-complete");
          closeTimer = setTimeout(() => source.terminate(), 2000);
          closeTimer.unref();
          return;
        }
        if (message.event === "error") {
          fail(String(message.detail ?? message.message ?? message.code ?? "Exposure failed")); return;
        }
      }
      client.send(data, {binary: isBinary});
    });
    source.on("error", error => {
      if (!done) {
        console.warn("[exposure-session] upstream error", {sessionId, message: error.message});
        fail("Exposure service connection failed; the segment was not replayed");
      }
    });
    source.on("close", () => {
      clearTimeout(closeTimer);
      if (upstream !== source) return;
      upstream = null;
      if (done && client.readyState === WebSocket.OPEN) client.send(done);
      else if (client.readyState === WebSocket.OPEN)
        fail("Exposure service disconnected before completion; the segment was not replayed");
    });
  });
}
