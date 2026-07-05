/**
 * useScanStream — opens the WebSocket to /ws/scan/{raster,vector}/stream,
 * sends the request body, and dispatches Redux actions for each frame
 * received. Exposes start / pause / stop callbacks.
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
 * Pause and Stop both close the WS with code 1000. The FastAPI service
 * maps that to its WebSocketDisconnect handler which calls gen.aclose() —
 * the same path examples/ws_client.py relies on for clean cancel.
 *
 * Close-handler invariant: after the WS closes, the scan phase MUST have
 * left "running"/"stopping". Three paths get us there:
 *   - "done" event arrived first (server completed the scan)
 *   - user closed it (closureKind = pause | stop)
 *   - upstream/server closed unexpectedly  -> we mark phase = error
 */
import { useCallback, useEffect, useRef } from "react";

import {
  streamCompleted,
  streamErrored,
  streamPaused,
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
import { wsUrl } from "../lib/backendUrl";

type Closure = "pause" | "stop";

export function useScanStream() {
  const dispatch = useAppDispatch();
  const wsRef = useRef<WebSocket | null>(null);
  const closureKindRef = useRef<Closure | null>(null);
  // Captures whether the server delivered a clean "done" event before
  // the socket closed; if so, we don't downgrade to "error" on close.
  const sawDoneRef = useRef<boolean>(false);

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
      const ws = wsRef.current;
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
      wsRef.current = null;
    };
  }, []);

  const startRaster = useCallback(
    (req: RasterRequest) => {
      stopExisting(wsRef);
      dispatch(resetRaster({ resolution: req.resolution }));
      dispatch(streamStarted());
      const ws = openWs("/ws/scan/raster/stream");
      wsRef.current = ws;
      closureKindRef.current = null;
      sawDoneRef.current = false;

      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) =>
        handleRasterMessage(ev, dispatch, sawDoneRef, req.output_mode);
      ws.onerror = () => {
        // The browser only emits a generic error event; details come via
        // the close handler. Don't transition phase here — onclose will.
      };
      ws.onclose = (ev) => {
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
    [dispatch]
  );

  const startVector = useCallback(
    (req: VectorRequest) => {
      stopExisting(wsRef);
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
        console.info("[scan/vector] ws-send", {
          preview: Boolean(req.preview),
          pattern: req.pattern,
          feedback_mode: req.feedback_mode ?? null,
          gray_level_range: req.gray_level_range ?? null,
          gray_level_skipped: req.gray_level_skipped ?? null,
          roi: req.roi != null,
          simulation_bitmap: req.simulation_bitmap != null,
        });
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) =>
        handleVectorMessage(
          ev,
          dispatch,
          sawDoneRef,
          vectorLineShiftPerXRow,
          req.output_mode,
        );
      ws.onerror = () => {
        /* see startRaster */
      };
      ws.onclose = (ev) => {
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
    [dispatch, vectorLineShiftPerXRow]
  );

  const pause = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    closureKindRef.current = "pause";
    dispatch(streamStopping());
    ws.close(1000, "pause");
  }, [dispatch]);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) {
      return;
    }
    closureKindRef.current = "stop";
    dispatch(streamStopping());
    ws.close(1000, "stop");
  }, [dispatch]);

  useEffect(() => {
    return registerScanActionStop(stop);
  }, [stop]);

  return { startRaster, startVector, pause, stop };
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

function handleRasterMessage(
  ev: MessageEvent,
  dispatch: ReturnType<typeof useAppDispatch>,
  sawDoneRef: React.MutableRefObject<boolean>,
  outputMode: string | undefined,
): void {
  if (typeof ev.data === "string") {
    try {
      const msg = JSON.parse(ev.data);
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
      /* ignore non-JSON text frames */
    }
    return;
  }
  const buf = ev.data as ArrayBuffer;
  const px = decodeSamples(buf, outputMode);
  dispatch(appendRaster({ pixels: px }));
  dispatch(streamProgress({ bytes: buf.byteLength, chunks: 1 }));
}

function handleVectorMessage(
  ev: MessageEvent,
  dispatch: ReturnType<typeof useAppDispatch>,
  sawDoneRef: React.MutableRefObject<boolean>,
  lineShiftPerXRow: number,
  outputMode: string | undefined,
): void {
  if (typeof ev.data === "string") {
    try {
      const msg = JSON.parse(ev.data);
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
      /* ignore */
    }
    return;
  }
  // Vector chunks are ADC samples in the same order the host's
  // point script generated commands — same wire format as raster, just
  // a different (x, y) → sample-index mapping (handled by the reducer).
  const buf = ev.data as ArrayBuffer;
  const values = decodeSamples(buf, outputMode);
  dispatch(appendVectorSamples({ values }));
  dispatch(streamProgress({ bytes: buf.byteLength, chunks: 1 }));
}

function finalize(
  closure: Closure | null,
  sawDone: boolean,
  currentPhase: string,
  currentChunks: number,
  ev: CloseEvent,
  dispatch: ReturnType<typeof useAppDispatch>
): void {
  if (closure === "pause") {
    dispatch(streamPaused());
    return;
  }
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
