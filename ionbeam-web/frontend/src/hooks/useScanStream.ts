/**
 * useScanStream — opens the WebSocket to /ws/scan/{raster,vector}/stream,
 * sends the request body, and dispatches Redux actions for each frame
 * received. Exposes start / stop callbacks.
 *
 * Pixel byte format (raster AND vector): the FPGA's ImageSerializer emits
 * HIGH byte then LOW byte for each uint16 ADC sample (see
 * applet/imageSerializer.py — "High" state outputs payload[8:16], then
 * transitions to "Low" state which outputs the saved low byte). We
 * reconstruct the full uint16 here and store it; the canvas painter
 * auto-levels at display time. Quantising to the high byte alone would
 * lose 8 bits of dynamic range and render typical ADC outputs (whose
 * values often sit in the low ~12 bits) as near-black.
 *
 * Vector format: the service streams uint16 ADC samples in the same
 * order the host's point script sent (x, y) commands. So bytes-per-sample
 * is 2, not 8, and (x, y) is reconstructed from sample index + pattern
 * by the imageSlice reducer — NOT carried inline with each sample.
 *
 * Stop closes the WS with code 1000. The FastAPI service
 * maps that to its WebSocketDisconnect handler which calls gen.aclose() —
 * the same path examples/ws_client.py relies on for clean cancel.
 *
 * Close-handler invariant: after the WS closes, the scan phase MUST have
 * left "running"/"stopping". Three paths get us there:
 *   - "done" event arrived first (server completed the scan)
 *   - user closed it (closureKind = stop)
 *   - upstream/server closed unexpectedly  -> we mark phase = error
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  streamCompleted,
  streamErrored,
  streamProgress,
  streamReset,
  streamStarted,
  streamStopping,
} from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import {
  appendRaster,
  appendVectorSamples,
  correctVectorLineShift,
  resetRaster,
  setupVector,
} from "../store/imageSlice";
import type { RasterRequest, VectorRequest } from "../types/api";
import type { RootState } from "../store";
import { registerScanActionStop } from "./scanActionRegistry";
import { withScanAuthQuery } from "../lib/authIdentity";
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { wsUrl } from "../lib/backendUrl";

type Closure = "stop";
type ActiveScan =
  | { kind: "raster"; req: RasterRequest }
  | { kind: "vector"; req: VectorRequest };
type PendingSamples = {
  chunks: Uint16Array[];
  bytes: number;
  chunkCount: number;
  animationFrame: number | null;
};

export function useScanStream() {
  const dispatch = useAppDispatch();
  const wsRef = useRef<WebSocket | null>(null);
  const closureKindRef = useRef<Closure | null>(null);
  // Captures whether the server delivered a clean "done" event before
  // the socket closed; if so, we don't downgrade to "error" on close.
  const sawDoneRef = useRef<boolean>(false);
  const activeScanRef = useRef<ActiveScan | null>(null);
  const autoReconnectAttemptedRef = useRef(false);
  const reconnectInFlightRef = useRef<Promise<boolean> | null>(null);
  const pendingRasterRef = useRef<PendingSamples>(createPendingSamples());
  const pendingVectorRef = useRef<PendingSamples>(createPendingSamples());

  // Read current phase reactively so the close handler can decide whether
  // to transition to error. Reading from store at close time avoids a
  // stale-closure bug where the dispatch fires after a user-initiated
  // reset.
  const phase = useAppSelector((s: RootState) => s.scan.phase);
  const chunksReceived = useAppSelector((s: RootState) => s.scan.chunksReceived);
  const vectorLineShiftPerXRow = useAppSelector((s: RootState) => {
    const raw = s.status.defaults?.vector?.lineShiftPerXRow;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const chunksReceivedRef = useRef(chunksReceived);
  chunksReceivedRef.current = chunksReceived;

  // Ensure WS is closed when the component using this hook unmounts so we
  // don't leak streams across page navigations.
  useEffect(() => {
    return () => {
      discardPendingSamples(pendingRasterRef.current);
      discardPendingSamples(pendingVectorRef.current);
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
      wsRef.current = null;
    };
  }, []);

  const flushRasterSamples = useCallback(() => {
    flushPendingSamples(pendingRasterRef.current, (pixels) => {
      dispatch(appendRaster({ pixels }));
    }, dispatch);
  }, [dispatch]);

  const flushVectorSamples = useCallback(() => {
    flushPendingSamples(pendingVectorRef.current, (values) => {
      dispatch(appendVectorSamples({ values }));
    }, dispatch);
  }, [dispatch]);

  const startRaster = useCallback(
    (req: RasterRequest) => {
      stopExisting(wsRef);
      discardPendingSamples(pendingRasterRef.current);
      activeScanRef.current = { kind: "raster", req };
      autoReconnectAttemptedRef.current = false;
      dispatch(resetRaster({ resolution: req.resolution }));
      dispatch(streamStarted());
      const ws = openWs("/ws/scan/raster/stream");
      wsRef.current = ws;
      closureKindRef.current = null;
      sawDoneRef.current = false;

      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        if (typeof ev.data !== "string") {
          const buf = ev.data as ArrayBuffer;
          queuePendingSamples(
            pendingRasterRef.current,
            decodeSamples(buf, req.output_mode),
            buf.byteLength,
            flushRasterSamples,
          );
          return;
        }
        flushRasterSamples();
        if (!handleRasterControlMessage(ev.data, dispatch, sawDoneRef)) {
          activeScanRef.current = null;
          ws.close(1002, "malformed control message");
        }
      };
      ws.onerror = () => {
        // The browser only emits a generic error event; details come via
        // the close handler. Don't transition phase here — onclose will.
      };
      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return;
        flushRasterSamples();
        finalize(
          closureKindRef.current,
          sawDoneRef.current,
          phaseRef.current,
          chunksReceivedRef.current,
          ev,
          dispatch,
        );
        wsRef.current = null;
      };
    },
    [dispatch, flushRasterSamples]
  );

  const startVector = useCallback(
    (req: VectorRequest) => {
      stopExisting(wsRef);
      discardPendingSamples(pendingVectorRef.current);
      activeScanRef.current = { kind: "vector", req };
      autoReconnectAttemptedRef.current = false;
      // Default-pattern scans store an edge x edge dense buffer. Explicit
      // custom bitmap simulations render in compact bitmap space, but a
      // default-pattern request with simulation_bitmap still scans at the
      // configured vector resolution.
      const edge = req.pattern === "custom" && req.simulation_bitmap
        ? Math.max(req.simulation_bitmap.width, req.simulation_bitmap.height)
        : req.pattern === "custom"
        ? 2048
        : req.vector_resolution;
      dispatch(
        setupVector({
          pattern: req.pattern,
          scanPath: req.scan_path,
          points: req.points,
          edge,
          roi: req.roi,
          simulationBitmap: req.simulation_bitmap
            ? {
                width: req.simulation_bitmap.width,
                height: req.simulation_bitmap.height,
              }
            : undefined,
        })
      );
      dispatch(streamStarted());
      const ws = openWs("/ws/scan/vector/stream");
      wsRef.current = ws;
      closureKindRef.current = null;
      sawDoneRef.current = false;

      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        console.info("[scan/vector] ws-send", {
          preview: Boolean(req.preview),
          pattern: req.pattern,
          scan_path: req.scan_path,
          feedback_mode: req.feedback_mode ?? null,
          gray_level_range: req.gray_level_range ?? null,
          gray_level_skipped: req.gray_level_skipped ?? null,
          roi: req.roi != null,
          simulation_bitmap: req.simulation_bitmap != null,
        });
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        if (typeof ev.data !== "string") {
          const buf = ev.data as ArrayBuffer;
          queuePendingSamples(
            pendingVectorRef.current,
            decodeSamples(buf, req.output_mode),
            buf.byteLength,
            flushVectorSamples,
          );
          return;
        }
        flushVectorSamples();
        const valid = handleVectorControlMessage(
          ev.data,
          dispatch,
          sawDoneRef,
          vectorLineShiftPerXRow,
        );
        if (!valid) {
          activeScanRef.current = null;
          ws.close(1002, "malformed control message");
        }
      };
      ws.onerror = () => {
        /* see startRaster */
      };
      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return;
        flushVectorSamples();
        void handleClose(
          ev,
          closureKindRef.current,
          sawDoneRef.current,
          phaseRef.current,
          chunksReceivedRef.current,
          dispatch,
          wsRef,
          activeScanRef,
          autoReconnectAttemptedRef,
          reconnectInFlightRef,
          startRaster,
          startVector,
        );
        wsRef.current = null;
      };
    },
    [dispatch, flushVectorSamples, vectorLineShiftPerXRow]
  );

  const stop = useCallback(() => {
    flushRasterSamples();
    flushVectorSamples();
    const ws = wsRef.current;
    const hadActiveScan = activeScanRef.current !== null;
    closureKindRef.current = "stop";
    activeScanRef.current = null;
    autoReconnectAttemptedRef.current = true;
    if (!ws) {
      if (hadActiveScan) dispatch(streamReset());
      return;
    }
    dispatch(streamStopping());
    ws.close(1000, "stop");
  }, [dispatch, flushRasterSamples, flushVectorSamples]);

  useEffect(() => {
    return registerScanActionStop(stop);
  }, [stop]);

  return useMemo(
    () => ({ startRaster, startVector, stop }),
    [startRaster, startVector, stop]
  );
}

/* -------- helpers ------------------------------------------------------ */

function openWs(path: string): WebSocket {
  return new WebSocket(wsUrl(withScanAuthQuery(path)));
}

function stopExisting(ref: React.MutableRefObject<WebSocket | null>): void {
  const ws = ref.current;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    ws.close(1000, "restart");
  }
  ref.current = null;
}

function decodeSamples(buf: ArrayBuffer, outputMode?: string): Uint16Array {
  if (outputMode === "EightBit") {
    const view = new Uint8Array(buf);
    const out = new Uint16Array(view.length);
    for (let i = 0; i < view.length; i++) {
      out[i] = view[i] << 8;
    }
    return out;
  }
  return decodeUint16BE(buf);
}

/** Reconstruct uint16 samples from a [hi, lo, hi, lo, ...] byte stream. */
function decodeUint16BE(buf: ArrayBuffer): Uint16Array {
  const view = new Uint8Array(buf);
  const n = view.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    out[i] = (view[j] << 8) | view[j + 1];
  }
  return out;
}

function handleRasterControlMessage(
  data: string,
  dispatch: ReturnType<typeof useAppDispatch>,
  sawDoneRef: React.MutableRefObject<boolean>,
): boolean {
  try {
    const msg = JSON.parse(data);
    if (msg.event === "done") {
      sawDoneRef.current = true;
      dispatch(
        streamCompleted({
          chunks: msg.chunks,
          kind: "raster",
          csv_filename: typeof msg.csv_filename === "string" ? msg.csv_filename : null,
          image_filename: typeof msg.image_filename === "string" ? msg.image_filename : null,
        }),
      );
    } else if (msg.event === "error") {
      dispatch(streamErrored(msg.detail ?? msg.message ?? msg.code ?? "stream error"));
    }
  } catch {
    dispatch(streamErrored("Malformed raster stream control message"));
    return false;
  }
  return true;
}

function handleVectorControlMessage(
  data: string,
  dispatch: ReturnType<typeof useAppDispatch>,
  sawDoneRef: React.MutableRefObject<boolean>,
  lineShiftPerXRow: number,
): boolean {
  try {
    const msg = JSON.parse(data);
    if (msg.event === "done") {
      sawDoneRef.current = true;
      dispatch(correctVectorLineShift({ lineShiftPerXRow }));
      dispatch(
        streamCompleted({
          chunks: msg.chunks,
          kind: "vector",
          csv_filename: typeof msg.csv_filename === "string" ? msg.csv_filename : null,
          image_filename: typeof msg.image_filename === "string" ? msg.image_filename : null,
        }),
      );
    } else if (msg.event === "error") {
      dispatch(streamErrored(msg.detail ?? msg.message ?? msg.code ?? "stream error"));
    }
  } catch {
    dispatch(streamErrored("Malformed vector stream control message"));
    return false;
  }
  return true;
}

function createPendingSamples(): PendingSamples {
  return { chunks: [], bytes: 0, chunkCount: 0, animationFrame: null };
}

function queuePendingSamples(
  pending: PendingSamples,
  samples: Uint16Array,
  bytes: number,
  flush: () => void,
): void {
  pending.chunks.push(samples);
  pending.bytes += bytes;
  pending.chunkCount += 1;
  if (pending.animationFrame === null) {
    pending.animationFrame = window.requestAnimationFrame(flush);
  }
}

function flushPendingSamples(
  pending: PendingSamples,
  append: (samples: Uint16Array) => void,
  dispatch: ReturnType<typeof useAppDispatch>,
): void {
  if (pending.animationFrame !== null) {
    window.cancelAnimationFrame(pending.animationFrame);
    pending.animationFrame = null;
  }
  if (pending.chunkCount === 0) return;

  const samples = concatenateSamples(pending.chunks);
  const bytes = pending.bytes;
  const chunks = pending.chunkCount;
  pending.chunks = [];
  pending.bytes = 0;
  pending.chunkCount = 0;
  append(samples);
  dispatch(streamProgress({ bytes, chunks }));
}

function discardPendingSamples(pending: PendingSamples): void {
  if (pending.animationFrame !== null) {
    window.cancelAnimationFrame(pending.animationFrame);
  }
  pending.chunks = [];
  pending.bytes = 0;
  pending.chunkCount = 0;
  pending.animationFrame = null;
}

function concatenateSamples(chunks: Uint16Array[]): Uint16Array {
  if (chunks.length === 1) return chunks[0];
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Uint16Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function finalize(
  closure: Closure | null,
  sawDone: boolean,
  currentPhase: string,
  currentChunks: number,
  ev: CloseEvent,
  dispatch: ReturnType<typeof useAppDispatch>
): void {
  if (closure === "stop") {
    dispatch(streamReset());
    return;
  }
  // Server-side closure. If a "done" event already moved phase to
  // "completed", or the user already saw an explicit error message, leave
  // it. Otherwise the close itself is the news, so transition to error.
  if (sawDone) return;
  if (ev.code === 1000 && (currentPhase === "running" || currentPhase === "stopping")) {
    dispatch(streamCompleted({ chunks: currentChunks }));
    return;
  }
  if (currentPhase === "running" || currentPhase === "stopping") {
    const reason = ev.reason || `WebSocket closed (code ${ev.code})`;
    dispatch(streamErrored(reason));
  }
}

function isRecoverableDisconnect(
  ev: CloseEvent,
  closure: Closure | null,
  sawDone: boolean,
  currentPhase: string
): boolean {
  if (closure === "stop" || sawDone) return false;
  if (currentPhase !== "running" && currentPhase !== "stopping") return false;
  const reason = `${ev.reason ?? ""} ${ev.code}`.toLowerCase();
  return (
    ev.code === 1011 ||
    ev.code === 1006 ||
    reason.includes("timeout") ||
    reason.includes("unreachable") ||
    reason.includes("upstream_error")
  );
}

async function reconnectGlasgow(): Promise<boolean> {
  const r = await fetch(apiUrl("/api/admin/reconnect"), {
    method: "POST",
    headers: scanAuthHeaders(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`reconnect: HTTP ${r.status} ${text}`.trim());
  }
  return true;
}

async function handleClose(
  ev: CloseEvent,
  closure: Closure | null,
  sawDone: boolean,
  currentPhase: string,
  currentChunks: number,
  dispatch: ReturnType<typeof useAppDispatch>,
  wsRef: React.MutableRefObject<WebSocket | null>,
  activeScanRef: React.MutableRefObject<ActiveScan | null>,
  autoReconnectAttemptedRef: React.MutableRefObject<boolean>,
  reconnectInFlightRef: React.MutableRefObject<Promise<boolean> | null>,
  startRaster: (req: RasterRequest) => void,
  startVector: (req: VectorRequest) => void,
): Promise<void> {
  if (!isRecoverableDisconnect(ev, closure, sawDone, currentPhase)) {
    finalize(closure, sawDone, currentPhase, currentChunks, ev, dispatch);
    return;
  }
  if (autoReconnectAttemptedRef.current) {
    finalize(closure, sawDone, currentPhase, currentChunks, ev, dispatch);
    return;
  }

  autoReconnectAttemptedRef.current = true;
  const activeScan = activeScanRef.current;
  if (!activeScan) {
    finalize(closure, sawDone, currentPhase, currentChunks, ev, dispatch);
    return;
  }

  if (!reconnectInFlightRef.current) {
    reconnectInFlightRef.current = (async () => {
      await reconnectGlasgow();
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      return true;
    })().finally(() => {
      reconnectInFlightRef.current = null;
    });
  }

  try {
    await reconnectInFlightRef.current;
    if (wsRef.current !== null || closure === "stop") {
      return;
    }
    if (activeScanRef.current?.kind === "raster" && activeScan.kind === "raster") {
      startRaster(activeScan.req);
    } else if (activeScanRef.current?.kind === "vector" && activeScan.kind === "vector") {
      startVector(activeScan.req);
    }
  } catch (err) {
    activeScanRef.current = null;
    dispatch(streamErrored(err instanceof Error ? err.message : String(err)));
  }
}
