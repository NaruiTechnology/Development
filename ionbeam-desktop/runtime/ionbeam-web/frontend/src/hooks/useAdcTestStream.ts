import { DesktopSocket as WebSocket } from "../lib/desktopSocket";
import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "../lib/backendUrl";
import { withScanAuthQuery } from "../lib/authIdentity";

export type AdcPhase = "idle" | "connecting" | "running" | "done" | "error";

export interface AdcBin {
  min: number;
  max: number;
  average: number;
  latest: number;
  count: number;
}

export interface AdcStreamState {
  phase: AdcPhase;
  bins: Array<AdcBin | null>;
  sampleCount: number;
  minimum: number | null;
  maximum: number | null;
  elapsedSeconds: number;
  durationMinutes: 5 | 10 | 15 | 20;
  error: string | null;
}

const BIN_COUNT = 2048;

export function useAdcTestStream() {
  const socketRef = useRef<WebSocket | null>(null);
  const startedAtRef = useRef(0);
  const binsRef = useRef<Array<AdcBin | null>>(emptyBins());
  const statsRef = useRef({ count: 0, min: null as number | null, max: null as number | null });
  const frameRef = useRef<number | null>(null);
  const durationRef = useRef<5 | 10 | 15 | 20>(5);
  const simulationRef = useRef(false);
  const [state, setState] = useState<AdcStreamState>(() => initialState(5));

  const publish = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const elapsedSeconds = startedAtRef.current
        ? Math.max(0, (Date.now() - startedAtRef.current) / 1000)
        : 0;
      setState((current) => ({
        ...current,
        bins: binsRef.current.slice(),
        sampleCount: statsRef.current.count,
        minimum: statsRef.current.min,
        maximum: statsRef.current.max,
        elapsedSeconds,
      }));
    });
  }, []);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "ADC test stopped");
    }
    setState((current) => ({
      ...current,
      phase: current.phase === "error" ? "error" : "done",
    }));
  }, []);

  const start = useCallback((request: {
    durationMinutes: 5 | 10 | 15 | 20;
    simulation: boolean;
    seed: number;
  }) => {
    const existing = socketRef.current;
    if (existing && existing.readyState <= WebSocket.OPEN) existing.close(1000, "restart");
    binsRef.current = emptyBins();
    statsRef.current = { count: 0, min: null, max: null };
    durationRef.current = request.durationMinutes;
    simulationRef.current = request.simulation;
    startedAtRef.current = Date.now();
    setState(initialState(request.durationMinutes, "connecting"));

    const socket = new WebSocket(wsUrl(withScanAuthQuery("/ws/adc/stream")));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({
        duration_minutes: request.durationMinutes,
        simulation: request.simulation,
        seed: request.seed,
        chunk_bytes: 65536,
      }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.event === "metadata") {
          startedAtRef.current = Date.now();
          setState((current) => ({ ...current, phase: "running", elapsedSeconds: 0 }));
        } else if (message.event === "done") {
          socketRef.current = null;
          setState((current) => ({ ...current, phase: "done" }));
        } else if (message.event === "error") {
          socketRef.current = null;
          setState((current) => ({
            ...current,
            phase: "error",
            error: normalizeAdcError(message),
          }));
        }
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      const elapsed = Math.max(0, (Date.now() - startedAtRef.current) / 1000);
      const durationSeconds = durationRef.current * 60;
      const binIndex = Math.min(BIN_COUNT - 1, Math.floor((elapsed / durationSeconds) * BIN_COUNT));
      let sum = 0;
      let count = 0;
      let min = 0x3fff;
      let max = 0;
      let latest = 0;
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        // ADC-only test samples are the raw 14-bit code, not the OBI-aligned
        // (code << 2) form that scan data uses.
        const value = ((bytes[index] << 8) | bytes[index + 1]) & 0x3fff;
        sum += value;
        count += 1;
        min = Math.min(min, value);
        max = Math.max(max, value);
        latest = value;
      }
      if (count) {
        const previous = binsRef.current[binIndex];
        const total = (previous?.average ?? 0) * (previous?.count ?? 0) + sum;
        const totalCount = (previous?.count ?? 0) + count;
        binsRef.current[binIndex] = {
          min: Math.min(previous?.min ?? min, min),
          max: Math.max(previous?.max ?? max, max),
          average: total / totalCount,
          latest,
          count: totalCount,
        };
        statsRef.current.count += count;
        statsRef.current.min = Math.min(statsRef.current.min ?? min, min);
        statsRef.current.max = Math.max(statsRef.current.max ?? max, max);
        publish();
      }
    };
    socket.onerror = () => {
      setState((current) => ({
        ...current,
        phase: "error",
        error: simulationRef.current ? "adc.error.simulation" : "adc.error.hardwareUnavailable",
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

  useEffect(() => {
    if (state.phase !== "running") return;
    const timer = window.setInterval(publish, 500);
    return () => window.clearInterval(timer);
  }, [publish, state.phase]);

  return { state, start, stop };
}

function normalizeAdcError(message: Record<string, unknown>): string {
  const detail = String(message.detail ?? message.message ?? message.code ?? "");
  if (/timeout\(\)|timed? ?out|timeout/i.test(detail)) return "adc.error.timeout";
  if (message.code === "upstream_unreachable") return "adc.error.hardwareUnavailable";
  return detail || "adc.error.generic";
}

function emptyBins(): Array<AdcBin | null> {
  return Array.from({ length: BIN_COUNT }, () => null);
}

function initialState(
  durationMinutes: 5 | 10 | 15 | 20,
  phase: AdcPhase = "idle",
): AdcStreamState {
  return {
    phase,
    bins: emptyBins(),
    sampleCount: 0,
    minimum: null,
    maximum: null,
    elapsedSeconds: 0,
    durationMinutes,
    error: null,
  };
}
