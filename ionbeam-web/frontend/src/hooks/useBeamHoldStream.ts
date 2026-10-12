/**
 * useBeamHoldStream — opens /ws/scan/beam_hold/stream for the blank
 * takeover check, records the parked-beam ADC signal into a compact
 * envelope (lib/beamHoldAnalysis.ts) and re-runs dip analysis about once a
 * second while it runs, and once more at the end.
 *
 * Self-contained like useDacRampStream: a parked beam is a 1D time series,
 * not an image, so it stays out of the raster/vector Redux pipeline.
 *
 * Wire format: a `metadata` text frame (sample_period_us), then binary
 * SixteenBit OBI-aligned uint16 samples (code << 2), then `done`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "../lib/backendUrl";
import { withScanAuthQuery } from "../lib/authIdentity";
import { decodeScanSamples } from "../lib/scanSamples";
import {
  BeamHoldRecorder,
  analyzeBeamHold,
  type BeamHoldAnalysis,
} from "../lib/beamHoldAnalysis";
import type { BeamHoldBeam, BeamHoldRequest, BeamHoldScanPlan } from "../types/api";

export type BeamHoldPhase = "idle" | "connecting" | "running" | "done" | "error";

export interface BeamHoldStreamState {
  phase: BeamHoldPhase;
  beam: BeamHoldBeam;
  externalControl: boolean;
  durationS: number;
  elapsedMs: number;
  sampleCount: number;
  samplePeriodUs: number | null;
  mock: boolean;
  analysis: BeamHoldAnalysis | null;
  /** Bumped whenever the recorder has new buckets to draw. */
  revision: number;
  error: string | null;
}

export interface BeamHoldStartOptions {
  xCode: number;
  yCode: number;
  beam: BeamHoldBeam;
  /** Sampling dwell of the recorded trace. */
  dwell: number;
  /** The scan whose takeover the hold reproduces. */
  match: BeamHoldScanPlan;
  /** Calculated hold time, until the service's metadata confirms it. */
  expectedSeconds: number;
  externalControl: boolean;
  adcValid: boolean;
  /** Session simulation override, as scan requests carry it. */
  simulation?: Record<string, unknown> | null;
}

/** Used until the metadata frame arrives: 8 MHz conversions. */
const FALLBACK_CONVERSION_HZ = 8_000_000;
const ANALYSIS_INTERVAL_MS = 1000;

export function useBeamHoldStream() {
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<BeamHoldRecorder | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastAnalysisRef = useRef(0);
  const [state, setState] = useState<BeamHoldStreamState>(() => initialState());

  const analyze = useCallback((): BeamHoldAnalysis | null => {
    const rec = recorderRef.current;
    if (!rec) return null;
    lastAnalysisRef.current = performance.now();
    return analyzeBeamHold(rec.means, rec.length, rec.bucketMs);
  }, []);

  const publish = useCallback((force = false) => {
    if (frameRef.current !== null && !force) return;
    const run = () => {
      frameRef.current = null;
      const rec = recorderRef.current;
      if (!rec) return;
      const due = force || performance.now() - lastAnalysisRef.current >= ANALYSIS_INTERVAL_MS;
      const analysis = due ? analyze() : undefined;
      setState((current) => ({
        ...current,
        elapsedMs: rec.elapsedMs,
        sampleCount: rec.sampleCount,
        revision: current.revision + 1,
        analysis: analysis === undefined ? current.analysis : analysis,
      }));
    };
    if (force) {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      run();
    } else {
      frameRef.current = window.requestAnimationFrame(run);
    }
  }, [analyze]);

  const finish = useCallback((phase: "done" | "error", error: string | null = null) => {
    publish(true);
    setState((current) => ({
      ...current,
      phase: current.phase === "error" ? "error" : phase,
      error: current.error ?? error,
    }));
  }, [publish]);

  const stop = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    // Closing the socket ends the hold on the service, which then hands
    // the instrument back before releasing the device.
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "beam hold stopped");
    finish("done");
  }, [finish]);

  const start = useCallback((options: BeamHoldStartOptions) => {
    const existing = socketRef.current;
    if (existing && existing.readyState <= WebSocket.OPEN) existing.close(1000, "restart");
    recorderRef.current = new BeamHoldRecorder(((options.dwell + 1) * 1e6) / FALLBACK_CONVERSION_HZ);
    lastAnalysisRef.current = performance.now();
    setState({
      ...initialState(),
      phase: "connecting",
      beam: options.beam,
      externalControl: options.externalControl,
      durationS: options.expectedSeconds,
    });

    const body: BeamHoldRequest = {
      x_code: options.xCode,
      y_code: options.yCode,
      beam: options.beam,
      dwell: options.dwell,
      match: options.match,
      latency_bytes: 16384,
      cookie: 125,
      external_control: options.externalControl,
      adc_valid: options.adcValid,
      ...(options.simulation ? { simulation: options.simulation } : {}),
    };

    const socket = new WebSocket(wsUrl(withScanAuthQuery("/ws/scan/beam_hold/stream")));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      setState((current) => ({ ...current, phase: "running" }));
      socket.send(JSON.stringify(body));
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.event === "metadata") {
          const period = Number(message.sample_period_us);
          if (Number.isFinite(period) && period > 0) {
            recorderRef.current = new BeamHoldRecorder(period);
          }
          const duration = Number(message.duration_s);
          setState((current) => ({
            ...current,
            samplePeriodUs: Number.isFinite(period) && period > 0 ? period : current.samplePeriodUs,
            durationS: Number.isFinite(duration) && duration > 0 ? duration : current.durationS,
            mock: message.mock === true,
          }));
        } else if (message.event === "done") {
          socketRef.current = null;
          finish("done");
        } else if (message.event === "error") {
          socketRef.current = null;
          finish("error", String(message.detail ?? message.message ?? message.code ?? "beamHold.error.generic"));
        }
        return;
      }
      const values = decodeScanSamples(event.data as ArrayBuffer, "SixteenBit");
      for (let i = 0; i < values.length; i++) values[i] >>= 2; // OBI-aligned -> 14-bit codes
      recorderRef.current?.push(values);
      publish();
    };
    socket.onerror = () => {
      finish("error", "beamHold.error.hardwareUnavailable");
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        finish("done");
      }
    };
  }, [finish, publish]);

  useEffect(() => () => {
    socketRef.current?.close(1000, "unmount");
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return { state, start, stop, recorderRef };
}

function initialState(): BeamHoldStreamState {
  return {
    phase: "idle",
    beam: "on",
    externalControl: true,
    durationS: 30,
    elapsedMs: 0,
    sampleCount: 0,
    samplePeriodUs: null,
    mock: false,
    analysis: null,
    revision: 0,
    error: null,
  };
}
