/**
 * useScanStream — opens the WebSocket to /ws/scan/{raster,vector}/stream,
 * sends the request body, and dispatches Redux actions for each frame
 * received. Exposes start / pause / stop callbacks.
 *
 * The WS pixel byte format coming back from the FastAPI service is what
 * the FPGA's ImageSerializer emits: for SixteenBit output mode, each
 * pixel is HIGH byte then LOW byte (see applet/imageSerializer.py). For
 * an 8-bit grayscale display we sample byte 0 of every pair — that IS the
 * 8-bit display value, equivalent to the EightBit output mode the
 * hardware supports.
 *
 * Vector frames arrive with a different layout: in our mock and in the
 * vector pipeline, each "value" in the chunk is a uint16. For visualisation
 * we treat them as a stream of values to plot at (i % res, i / res).
 *
 * Pause / Stop both close the WS with code 1000. The FastAPI service maps
 * that to its WebSocketDisconnect handler which calls gen.aclose() — the
 * same path the existing examples/ws_client.py relies on for clean cancel.
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
  appendVector,
  resetRaster,
  resetVector,
} from "../store/imageSlice";
import type { RasterRequest, VectorRequest } from "../types/api";

type Closure = "pause" | "stop";

export function useScanStream() {
  const dispatch = useAppDispatch();
  const wsRef = useRef<WebSocket | null>(null);
  const closureKindRef = useRef<Closure | null>(null);

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

      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) => handleRasterMessage(ev, dispatch);
      ws.onerror = () => {
        dispatch(streamErrored("WebSocket error (network or upstream)"));
      };
      ws.onclose = () => {
        finalize(closureKindRef.current, dispatch, "raster");
        wsRef.current = null;
      };
    },
    [dispatch]
  );

  const startVector = useCallback(
    (req: VectorRequest) => {
      stopExisting(wsRef);
      dispatch(resetVector());
      dispatch(streamStarted());
      const ws = openWs("/ws/scan/vector/stream");
      wsRef.current = ws;
      closureKindRef.current = null;

      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify(req));
      };
      ws.onmessage = (ev) => handleVectorMessage(ev, dispatch);
      ws.onerror = () => {
        dispatch(streamErrored("WebSocket error (network or upstream)"));
      };
      ws.onclose = () => {
        finalize(closureKindRef.current, dispatch, "vector");
        wsRef.current = null;
      };
    },
    [dispatch]
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
      dispatch(streamReset());
      return;
    }
    closureKindRef.current = "stop";
    dispatch(streamStopping());
    ws.close(1000, "stop");
  }, [dispatch]);

  return { startRaster, startVector, pause, stop };
}

/* -------- helpers ------------------------------------------------------ */

function openWs(path: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}${path}`);
}

function stopExisting(ref: React.MutableRefObject<WebSocket | null>): void {
  const ws = ref.current;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    ws.close(1000, "restart");
  }
  ref.current = null;
}

function handleRasterMessage(
  ev: MessageEvent,
  dispatch: ReturnType<typeof useAppDispatch>
): void {
  if (typeof ev.data === "string") {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "done") {
        dispatch(streamCompleted({ chunks: msg.chunks }));
      } else if (msg.event === "error") {
        dispatch(streamErrored(msg.detail ?? msg.code ?? "stream error"));
      }
    } catch {
      /* ignore non-JSON text frames */
    }
    return;
  }
  // Binary frame: ArrayBuffer of [hi, lo, hi, lo, ...] uint16 samples.
  // We sample the high byte of each pair as the 8-bit display value.
  const buf = ev.data as ArrayBuffer;
  const view = new Uint8Array(buf);
  const nPixels = view.length >> 1;
  const px = new Uint8ClampedArray(nPixels);
  for (let i = 0, j = 0; i < nPixels; i++, j += 2) {
    px[i] = view[j];
  }
  dispatch(appendRaster({ pixels: px }));
  dispatch(streamProgress({ bytes: view.length, chunks: 1 }));
}

function handleVectorMessage(
  ev: MessageEvent,
  dispatch: ReturnType<typeof useAppDispatch>
): void {
  if (typeof ev.data === "string") {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "done") {
        dispatch(streamCompleted({ chunks: msg.chunks }));
      } else if (msg.event === "error") {
        dispatch(streamErrored(msg.detail ?? msg.code ?? "stream error"));
      }
    } catch {
      /* ignore */
    }
    return;
  }
  const buf = ev.data as ArrayBuffer;
  const view = new DataView(buf);
  // Vector mock format: 4 uint16 per point, big-endian: x, y, dwell, value.
  // Real hardware vector chunks differ, but the front-end's only job here
  // is to plot something the operator can read. If the byte length isn't a
  // multiple of 8, we fall back to treating values as a flat uint16 stream.
  const len = view.byteLength;
  if (len % 8 === 0) {
    const points = len / 8;
    const triples = new Float32Array(points * 3);
    for (let i = 0; i < points; i++) {
      const o = i * 8;
      triples[i * 3 + 0] = view.getUint16(o + 0);
      triples[i * 3 + 1] = view.getUint16(o + 2);
      triples[i * 3 + 2] = view.getUint16(o + 6) >> 8; // value -> 8bit
    }
    dispatch(appendVector({ triples }));
  }
  dispatch(streamProgress({ bytes: len, chunks: 1 }));
}

function finalize(
  closure: Closure | null,
  dispatch: ReturnType<typeof useAppDispatch>,
  _kind: "raster" | "vector"
): void {
  // The "done" event will already have moved us to "completed". If the
  // socket closed without a "done" frame, the user-driven closure wins.
  if (closure === "pause") dispatch(streamPaused());
  else if (closure === "stop") dispatch(streamReset());
}
