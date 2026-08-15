export const GLASGOW_REVC3_CLOCK_HZ = 48_000_000;
export const GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES = 4;

export interface ScanTimingEstimate {
  samplePeriodNs: number;
  pixelDwellNs: number;
  pixelRate: number;
  pixelCount: number;
  frameSeconds: number;
}

/**
 * The current revC3 gateware toggles adc_clk every adcHalfPeriod sync
 * clocks, so one complete ADC/DAC sample period is twice that value.
 * This is the acquisition floor; USB and host overhead can only make a
 * completed scan slower.
 */
export function estimateRevC3ScanTiming(
  resolution: number,
  dwell: number,
): ScanTimingEstimate {
  const safeResolution = Math.max(1, Math.trunc(resolution));
  const safeDwell = Math.max(1, Math.trunc(dwell));
  const samplePeriodNs =
    (2 * GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES * 1e9) /
    GLASGOW_REVC3_CLOCK_HZ;
  const pixelDwellNs = samplePeriodNs * safeDwell;
  const pixelRate = 1e9 / pixelDwellNs;
  const pixelCount = safeResolution * safeResolution;

  return {
    samplePeriodNs,
    pixelDwellNs,
    pixelRate,
    pixelCount,
    frameSeconds: (pixelCount * pixelDwellNs) / 1e9,
  };
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
