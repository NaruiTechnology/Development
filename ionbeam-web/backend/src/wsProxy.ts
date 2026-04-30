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
 * In MOCK=1 mode we never connect upstream; we synthesise frames in this
 * process instead.
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { URL } from "node:url";
import { config } from "./config";
import { streamMockRaster, streamMockVector } from "./mockHardware";

type ScanKind = "raster" | "vector";

const STREAM_PATHS: Record<string, ScanKind> = {
  "/ws/scan/raster/stream": "raster",
  "/ws/scan/vector/stream": "vector",
};

export function attachWsProxy(server: HttpServer): void {
  // noServer: we drive the upgrade manually so we can route by path.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
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

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      if (config.mock) {
        handleMock(clientWs, kind, req);
      } else {
        handleProxy(clientWs, kind, req);
      }
    });
  });
}

/* -------- real upstream pipe ------------------------------------------- */

function handleProxy(
  client: WebSocket,
  kind: ScanKind,
  req: IncomingMessage
): void {
  const upstreamUrl = `${config.proxyTargetWs}/scan/${kind}/stream`;
  const headers: Record<string, string> = {};
  if (config.glasgowToken) {
    headers["Authorization"] = `Bearer ${config.glasgowToken}`;
  }

  const upstream = new WebSocket(upstreamUrl, { headers });

  // Buffer client frames sent before upstream is open. Almost always this
  // is just the first JSON request, but bufferless drop loses scan params.
  // (Type matches WebSocket.RawData in @types/ws; inlined to keep the
  //  named-import style.)
  const earlyFrames: Array<Buffer | ArrayBuffer | Buffer[]> = [];
  let upstreamOpen = false;

  client.on("message", (data) => {
    if (upstreamOpen) {
      upstream.send(data);
    } else {
      earlyFrames.push(data);
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
    for (const f of earlyFrames) upstream.send(f);
    earlyFrames.length = 0;
  });

  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });

  upstream.on("close", (code, reason) => {
    if (
      client.readyState === WebSocket.OPEN ||
      client.readyState === WebSocket.CONNECTING
    ) {
      client.close(code === 1006 ? 1011 : code, reason);
    }
  });

  upstream.on("error", (err) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          event: "error",
          code: "upstream_unreachable",
          detail: err.message,
        })
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

/* -------- MOCK=1 path -------------------------------------------------- */

function handleMock(
  client: WebSocket,
  kind: ScanKind,
  req: IncomingMessage
): void {
  console.log(`[ws][mock] ${req.socket.remoteAddress} -> ${kind} stream`);
  client.once("message", async (raw) => {
    let req: any;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      client.send(JSON.stringify({ event: "error", code: "bad_json" }));
      client.close(1003, "bad json");
      return;
    }
    try {
      if (kind === "raster") {
        await streamMockRaster(client, {
          resolution: Number(req.resolution ?? 256),
          dwell: Number(req.dwell ?? 2),
          latency_bytes: Number(req.latency_bytes ?? 16384),
        });
      } else {
        await streamMockVector(client, {
          pattern: req.pattern === "custom" ? "custom" : "default",
          points: Array.isArray(req.points) ? req.points : undefined,
          latency_bytes: Number(req.latency_bytes ?? 8196),
        });
      }
    } catch (e: any) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ event: "error", message: String(e) }));
      }
    } finally {
      if (client.readyState === WebSocket.OPEN) client.close(1000);
    }
  });
}
