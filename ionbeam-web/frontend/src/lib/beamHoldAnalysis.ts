/**
 * Beam hold analysis: turn a long parked-beam ADC stream into a compact
 * envelope and find the short dark dips that cause black lines.
 *
 * With the beam parked and (when external control is on) our blanker in
 * charge, the detector signal should be flat. A dip that repeats on a
 * fixed period, independent of our scan settings, points at something
 * outside our scan, typically the instrument's own blanker.
 *
 * Samples arrive at up to ~1 MS/s for minutes, so they are reduced on
 * arrival into fixed-width time buckets (mean + minimum). Dip detection
 * runs on bucket means against a slowly varying baseline.
 */

/** Width of one envelope bucket. 0.25 ms resolves a 1 ms dip in 4 buckets. */
export const BEAM_HOLD_BUCKET_MS = 0.25;

/** Baseline block: dips are short, so a 100 ms median ignores them. */
const BASELINE_BLOCK_MS = 100;

export class BeamHoldRecorder {
  readonly bucketMs: number;
  readonly samplesPerBucket: number;
  means: Float32Array;
  mins: Float32Array;
  /** Completed buckets. */
  length = 0;
  sampleCount = 0;
  private sum = 0;
  private min = Infinity;
  private filled = 0;

  constructor(samplePeriodUs: number, bucketMs = BEAM_HOLD_BUCKET_MS) {
    const periodUs = samplePeriodUs > 0 ? samplePeriodUs : 1;
    this.samplesPerBucket = Math.max(1, Math.round((bucketMs * 1000) / periodUs));
    // Exact bucket width after rounding to whole samples.
    this.bucketMs = (this.samplesPerBucket * periodUs) / 1000;
    this.means = new Float32Array(4096);
    this.mins = new Float32Array(4096);
  }

  /** Add 14-bit samples (0..16383). */
  push(values: ArrayLike<number>): void {
    const per = this.samplesPerBucket;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      this.sum += v;
      if (v < this.min) this.min = v;
      this.filled++;
      if (this.filled === per) {
        this.append(this.sum / per, this.min);
        this.sum = 0;
        this.min = Infinity;
        this.filled = 0;
      }
    }
    this.sampleCount += values.length;
  }

  get elapsedMs(): number {
    return this.length * this.bucketMs;
  }

  private append(mean: number, min: number): void {
    if (this.length === this.means.length) {
      const grow = (src: Float32Array) => {
        const next = new Float32Array(src.length * 2);
        next.set(src);
        return next;
      };
      this.means = grow(this.means);
      this.mins = grow(this.mins);
    }
    this.means[this.length] = mean;
    this.mins[this.length] = min;
    this.length++;
  }
}

export interface BeamHoldDip {
  startMs: number;
  lengthMs: number;
  /** Baseline minus the dip's lowest bucket mean, in 14-bit ADC codes. */
  depth: number;
}

export type BeamHoldVerdict = "tooShort" | "clean" | "periodic" | "irregular";

export interface BeamHoldAnalysis {
  baseline: number;
  noise: number;
  threshold: number;
  dips: BeamHoldDip[];
  medianSpacingMs: number | null;
  medianLengthMs: number | null;
  dipsPerSecond: number;
  verdict: BeamHoldVerdict;
}

function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find dark dips in bucket means.
 *
 * Baseline: median of each 100 ms block, smoothed over its neighbours, so
 * slow drift (charging, stage settling) is not reported as a dip.
 * Threshold: a dip is lower than the baseline by at least 8 robust sigma
 * of the bucket noise, 10% of the baseline, or 32 codes, whichever is
 * largest. Neighbouring low runs closer than 2 buckets are merged.
 */
export function analyzeBeamHold(
  means: ArrayLike<number>,
  length: number,
  bucketMs: number,
): BeamHoldAnalysis {
  const n = Math.min(length, means.length);
  const perBlock = Math.max(1, Math.round(BASELINE_BLOCK_MS / bucketMs));
  const blocks = Math.floor(n / perBlock);
  if (blocks < 3) {
    return {
      baseline: 0, noise: 0, threshold: 0, dips: [],
      medianSpacingMs: null, medianLengthMs: null, dipsPerSecond: 0,
      verdict: "tooShort",
    };
  }

  const blockMedians = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    blockMedians[b] = median(Array.prototype.slice.call(means, b * perBlock, (b + 1) * perBlock));
  }
  const smoothed = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    smoothed[b] = median(blockMedians.slice(Math.max(0, b - 2), Math.min(blocks, b + 3)));
  }
  const baselineAt = (i: number) => smoothed[Math.min(blocks - 1, Math.floor(i / perBlock))];

  // Robust noise from at most ~200k evenly spaced residuals: long holds
  // reach millions of buckets and the estimate does not need them all.
  const span = blocks * perBlock;
  const stride = Math.max(1, Math.ceil(span / 200_000));
  const residuals: number[] = [];
  for (let i = 0; i < span; i += stride) residuals.push(Math.abs(means[i] - baselineAt(i)));
  const noise = 1.4826 * median(residuals);
  const baseline = median(blockMedians);
  const delta = Math.max(8 * noise, 0.1 * baseline, 32);

  const dips: BeamHoldDip[] = [];
  let start = -1;
  let lowest = Infinity;
  let gap = 0;
  const close = (endExclusive: number) => {
    dips.push({
      startMs: start * bucketMs,
      lengthMs: (endExclusive - start) * bucketMs,
      depth: baselineAt(start) - lowest,
    });
    start = -1;
    lowest = Infinity;
    gap = 0;
  };
  for (let i = 0; i < n; i++) {
    const low = means[i] < baselineAt(i) - delta;
    if (low) {
      if (start < 0) start = i;
      lowest = Math.min(lowest, means[i]);
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= 2) close(i - gap + 1);
    }
  }
  if (start >= 0) close(n - gap);

  const spacings = dips.slice(1).map((d, k) => d.startMs - dips[k].startMs);
  const medianSpacingMs = spacings.length ? median(spacings) : null;
  const medianLengthMs = dips.length ? median(dips.map((d) => d.lengthMs)) : null;
  const seconds = (n * bucketMs) / 1000;

  let verdict: BeamHoldVerdict = "clean";
  if (dips.length >= 3 && medianSpacingMs) {
    // Periodic when most spacings sit within 20% of the median.
    const regular = spacings.filter((s) => Math.abs(s - medianSpacingMs) <= 0.2 * medianSpacingMs);
    verdict = regular.length >= 0.7 * spacings.length ? "periodic" : "irregular";
  } else if (dips.length > 0) {
    verdict = "irregular";
  }

  return {
    baseline,
    noise,
    threshold: baseline - delta,
    dips,
    medianSpacingMs,
    medianLengthMs,
    dipsPerSecond: seconds > 0 ? dips.length / seconds : 0,
    verdict,
  };
}
