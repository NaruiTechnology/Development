export const GLASGOW_REVC3_CLOCK_HZ = 48_000_000;
export const GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES = 3;

export interface ScanTimingEstimate {
  /** One ADC conversion, in ns (2 x half-period FPGA clocks). */
  samplePeriodNs: number;
  /** ADC conversions averaged into one pixel: dwell + 1. */
  samplesPerPixel: number;
  pixelDwellNs: number;
  pixelRate: number;
  pixelCount: number;
  frameSeconds: number;
}

export interface DwellPresetOption {
  value: number;
  label: string;
}

/**
 * ADC conversions averaged into one pixel for a given dwell.
 *
 * The gateware emits `dwell_time + 1` conversions per pixel (measured end to
 * end: dwell_time 0, 1, 3, 7 -> 1, 2, 4, 8 conversions), and this UI sends the
 * dwell value unchanged, so a dwell of N averages N + 1 samples. Upstream
 * OBI's GUI hides this by sending `dwell - 1`; ours does not. Gateware test:
 * unittest/applet/test_dwellSemantics.py; service boundary test:
 * glasgow_service/tests/test_dwell_boundary.py.
 */
export function samplesPerPixel(dwell: number): number {
  return Math.max(0, Math.trunc(dwell)) + 1;
}

/**
 * The current revC3 gateware toggles adc_clk every adcHalfPeriod sync
 * clocks, so one ADC conversion is twice that value in FPGA clocks, and a
 * pixel takes `samplesPerPixel(dwell)` conversions. This is the acquisition
 * floor; USB and host overhead can only make a completed scan slower.
 */
export function estimateRevC3ScanTiming(
  resolution: number,
  dwell: number,
  adcHalfPeriod = GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES,
): ScanTimingEstimate {
  const safeResolution = Math.max(1, Math.trunc(resolution));
  const samples = samplesPerPixel(dwell);
  const samplePeriodNs =
    (2 * (Number.isFinite(adcHalfPeriod) && adcHalfPeriod >= 3
      ? adcHalfPeriod : GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES) * 1e9) /
    GLASGOW_REVC3_CLOCK_HZ;
  const pixelDwellNs = samplePeriodNs * samples;
  const pixelRate = 1e9 / pixelDwellNs;
  const pixelCount = safeResolution * safeResolution;

  return {
    samplePeriodNs,
    samplesPerPixel: samples,
    pixelDwellNs,
    pixelRate,
    pixelCount,
    frameSeconds: (pixelCount * pixelDwellNs) / 1e9,
  };
}

/** Human-readable choices for the dwell combobox.
 *
 * “MS/s” is deliberately kept separate from “MPix/s”: the converter keeps
 * sampling at 8 MS/s while averaging reduces the number of completed output
 * pixels per second.
 *
 * The presets are 2^k - 1 because a dwell of N averages N + 1 samples, and the
 * supersampler only averages the largest power-of-two prefix of them: 1, 3, 7,
 * 15, ... give 2, 4, 8, 16, ... samples with none wasted.
 */
export function revC3DwellPresetOptions(
  values: readonly number[] = [0, 1, 3, 7, 15, 31, 63],
  adcHalfPeriod = GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES,
): DwellPresetOption[] {
  return values.map((value) => {
    const timing = estimateRevC3ScanTiming(1, value, adcHalfPeriod);
    return {
      value,
      label: `${value} — ${timing.samplesPerPixel} samples/pixel — ${formatNanoseconds(timing.pixelDwellNs)} — ${formatPixelRate(timing.pixelRate)}`,
    };
  });
}

export function formatPixelRate(pixelsPerSecond: number): string {
  if (pixelsPerSecond >= 1e6) {
    return `${(pixelsPerSecond / 1e6).toFixed(pixelsPerSecond % 1e6 === 0 ? 1 : 2)} MPix/s`;
  }
  return `${(pixelsPerSecond / 1e3).toFixed(pixelsPerSecond % 1e3 === 0 ? 0 : 2)} kPix/s`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(1)} ns`;
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(1)} µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(1)} ms`;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

export function formatNanoseconds(nanoseconds: number): string {
  if (nanoseconds < 1_000) return `${nanoseconds.toFixed(1)} ns`;
  if (nanoseconds < 1_000_000) return `${(nanoseconds / 1_000).toFixed(2)} µs`;
  return `${(nanoseconds / 1_000_000).toFixed(2)} ms`;
}
