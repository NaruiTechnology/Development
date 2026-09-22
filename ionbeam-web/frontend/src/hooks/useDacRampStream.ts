/**
 * useDacRampStream — opens /ws/scan/dac_ramp/stream, sends a
 * DacRampRequest, and accumulates the returned samples into a single
 * 16384-point buffer indexed by position along the swept axis (0 = DAC
 * code 0, 16383 = DAC code 16383).
 *
 * This intentionally does NOT go through useScanStream/imageSlice: that
 * pipeline paints a 2D pixel image from a raster/vector scan, and a DAC
 * ramp is a 1D sweep (one axis pinned) — reusing it would mean adding a
 * "dac_ramp" case throughout image reducers and ScanControls that don't
 * otherwise need to know it exists. Mirroring useAdcTestStream.ts (an
 * existing, equally self-contained hardware diagnostic) keeps this
 * feature's blast radius limited to its own hook + components, matching
 * how the ADC-only test is already isolated from the main scan pipeline.
 *
 * Wire format: identical to raster/vector — binary frames are
 * SixteenBit OBI-aligned uint16 samples (code << 2), decoded with the
 * same decodeScanSamples() helper, then right-shifted by 2 for display
 * on the same 0..16383 DAC-code scale used elsewhere (e.g.
 * manual_dac_ctrl.py's _adc_u16_to_u14).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "../lib/backendUrl";
import { withScanAuthQuery } from "../lib/authIdentity";
import { decodeScanSamples } from "../lib/scanSamples";
import type { DacRampAxis, DacRampRequest } from "../types/api";

export type DacRampPhase = "idle" | "connecting" | "running" | "done" | "error";

export interface DacRampStreamState {
  phase: DacRampPhase;
  axis: DacRampAxis;
  /** 16384 points; null until a sample lands at that position. */
  samples: Array<number | null>;
  sampleCount: number;
  error: string | null;
}

const POINT_COUNT = 16384;

export function useDacRampStream() {
  const socketRef = useRef<WebSocket | null>(null);
  const samplesRef = useRef<Array<number | null>>(emptySamples());
  const cursorRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [state, setState] = useState<DacRampStreamState>(() => initialState("x"));

  const publish = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setState((current) => ({
        ...current,
        samples: samplesRef.current.slice(),
        sampleCount: cursorRef.current,
      }));
    });
  }, []);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "DAC ramp test stopped");
    }
    setState((current) => ({
      ...current,
      phase: current.phase === "error" ? "error" : "done",
    }));
  }, []);

  const start = useCallback((request: {
    axis: DacRampAxis;
    fixedCode: number;
    dwell: number;
    adcValid: boolean;
  }) => {
    const existing = socketRef.current;
    if (existing && existing.readyState <= WebSocket.OPEN) existing.close(1000, "restart");
    samplesRef.current = emptySamples();
    cursorRef.current = 0;
    setState(initialState(request.axis, "connecting"));

    const body: DacRampRequest = {
      axis: request.axis,
      fixed_code: request.fixedCode,
      dwell: request.dwell,
      latency_bytes: 16384,
      cookie: 123,
      beam_type: "Ion",
      external_control: true,
      adc_valid: request.adcValid,
    };

    const socket = new WebSocket(wsUrl(withScanAuthQuery("/ws/scan/dac_ramp/stream")));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      setState((current) => ({ ...current, phase: "running" }));
      socket.send(JSON.stringify(body));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.event === "done") {
          socketRef.current = null;
          publish();
          setState((current) => ({ ...current, phase: "done" }));
        } else if (message.event === "error") {
          socketRef.current = null;
          setState((current) => ({
            ...current,
            phase: "error",
            error: String(message.detail ?? message.message ?? message.code ?? "dacRamp.error.generic"),
          }));
        }
        return;
      }
      const values = decodeScanSamples(event.data as ArrayBuffer, "SixteenBit");
      const buf = samplesRef.current;
      for (let i = 0; i < values.length && cursorRef.current < POINT_COUNT; i++, cursorRef.current++) {
        buf[cursorRef.current] = values[i] >> 2; // OBI-aligned -> 0..16383 DAC-code scale
      }
      publish();
    };
    socket.onerror = () => {
      setState((current) => ({
        ...current,
        phase: "error",
        error: "dacRamp.error.hardwareUnavailable",
      }));
    };
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      setState((current) => current.phase === "running" || current.phase === "connecting"
        ? { ...current, phase: "done" }
        : current);
    };
  }, [publish]);

  useEffect(() => () => {
    socketRef.current?.close(1000, "unmount");
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return { state, start, stop };
}

function emptySamples(): Array<number | null> {
  return new Array(POINT_COUNT).fill(null);
}

function initialState(axis: DacRampAxis, phase: DacRampPhase = "idle"): DacRampStreamState {
  return {
    phase,
    axis,
    samples: emptySamples(),
    sampleCount: 0,
    error: null,
  };
}
