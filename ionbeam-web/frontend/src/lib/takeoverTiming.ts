/**
 * How long a scan holds external control (the takeover), calculated from the
 * scan itself: frames x frame time, plus the relay switch delay at takeover
 * and at hand-back.
 *
 * The scan does not run on this number. It takes control when it starts and
 * hands back when its last frame ends, so a slower USB link only makes the
 * takeover longer, never shorter than the scan. This estimate is shown before
 * Run and used by Beam hold to reproduce the same takeover with the beam
 * parked.
 *
 * Frame blank adds no measurable time: our blanker switches with the last
 * pixel of one frame and the first pixel of the next, microseconds apart.
 * It changes what the beam does between frames, not how long control is held.
 */
import { GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES, GLASGOW_REVC3_CLOCK_HZ } from "./scanTiming.js";
import { MAX_REPEAT_FRAMES } from "./scanRepeat.js";
import { vectorScanSampleCount } from "./vectorScanPath.js";
import type { VectorScanPath } from "../types/api.js";

/** Default relay switch delay (streamData.json timings.ext_switch_delay_ms). */
export const DEFAULT_SWITCH_DELAY_MS = 20;

export interface TakeoverPlan {
  /** Pixels (raster) or points (vector) in one frame / pass. */
  framePixels: number;
  /** Scan dwell: each pixel averages dwell + 1 ADC conversions. */
  dwell: number;
  /** Frames in the session; null = Infinite (until Stop). */
  frames: number | null;
  frameBlank: boolean;
  switchDelayMs?: number;
  adcHalfPeriod?: number;
}

export interface TakeoverEstimate {
  frames: number | null;
  framePixels: number;
  frameSeconds: number;
  /** All frames; null for Infinite. */
  scanSeconds: number | null;
  /** Takeover + hand-back relay switching. */
  switchSeconds: number;
  /** Whole takeover, from the Scan click to hand-back; null for Infinite. */
  totalSeconds: number | null;
  frameBlank: boolean;
}

export function conversionHz(adcHalfPeriod = GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES): number {
  const half = Number.isFinite(adcHalfPeriod) && adcHalfPeriod >= 3
    ? adcHalfPeriod
    : GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES;
  return GLASGOW_REVC3_CLOCK_HZ / (2 * half);
}

export function estimateTakeover(plan: TakeoverPlan): TakeoverEstimate {
  const framePixels = Math.max(1, Math.trunc(plan.framePixels));
  const dwell = Math.max(0, Math.trunc(plan.dwell));
  const frameSeconds = (framePixels * (dwell + 1)) / conversionHz(plan.adcHalfPeriod);
  const switchMs = Number.isFinite(plan.switchDelayMs) && (plan.switchDelayMs as number) >= 0
    ? (plan.switchDelayMs as number)
    : DEFAULT_SWITCH_DELAY_MS;
  const switchSeconds = (2 * switchMs) / 1000;
  const frames = plan.frames == null ? null : Math.max(1, Math.trunc(plan.frames));
  const scanSeconds = frames == null ? null : frames * frameSeconds;
  return {
    frames,
    framePixels,
    frameSeconds,
    scanSeconds,
    switchSeconds,
    totalSeconds: scanSeconds == null ? null : scanSeconds + switchSeconds,
    frameBlank: plan.frameBlank,
  };
}

/** The scan settings the takeover depends on (plain values, no store). */
export interface ScanTakeoverSettings {
  kind: "raster" | "vector";
  raster: { resolution: number; dwell: number; frame_blank: boolean };
  vector: {
    pattern: string;
    vector_resolution: number;
    scan_path: VectorScanPath;
    points: ArrayLike<unknown> | null;
    dwell: number;
  };
  /** Repeat N (Vector only; Raster runs one frame per Run). */
  repeat: number;
  /** Infinite: control is held until Stop. */
  infinite?: boolean;
  /** Frame blank the service applies to vector scans (raster_params). */
  defaultFrameBlank: boolean;
  switchDelayMs?: number;
  adcHalfPeriod?: number;
}

/** The takeover plan of the scan Run would start with these settings. */
export function takeoverPlanForScan(s: ScanTakeoverSettings): TakeoverPlan {
  const repeat = Math.max(1, Math.min(MAX_REPEAT_FRAMES, Math.trunc(Number(s.repeat) || 1)));
  if (s.kind === "raster") {
    const edge = Math.max(1, Math.trunc(s.raster.resolution));
    return {
      framePixels: edge * edge,
      dwell: s.raster.dwell,
      frames: s.infinite ? null : 1,
      frameBlank: s.raster.frame_blank,
      switchDelayMs: s.switchDelayMs,
      adcHalfPeriod: s.adcHalfPeriod,
    };
  }
  const edge = Math.max(1, Math.trunc(s.vector.vector_resolution));
  const framePixels = s.vector.pattern === "custom" && s.vector.points && s.vector.points.length > 0
    ? s.vector.points.length
    : vectorScanSampleCount(edge, s.vector.scan_path);
  return {
    framePixels,
    dwell: s.vector.dwell,
    frames: s.infinite ? null : repeat,
    frameBlank: s.defaultFrameBlank,
    switchDelayMs: s.switchDelayMs,
    adcHalfPeriod: s.adcHalfPeriod,
  };
}

/**
 * Whether a scan would use the hardware, and so take over the instrument:
 * the service's rule (DeviceService._hardware_free). IsProduction=true always
 * does; IsProduction=false does only with simulation switched off, by the
 * service default or the browser's session override.
 */
export function scansUseHardware(
  isProduction: boolean | undefined,
  simulation: Record<string, unknown> | null | undefined,
): boolean {
  if (isProduction !== false) return true;
  return simulation?.enabled === false;
}
