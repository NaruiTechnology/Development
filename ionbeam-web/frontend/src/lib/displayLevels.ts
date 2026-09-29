/**
 * Display levels for the live/result scan image (the "wedge").
 *
 * The ADC delivers OBI-aligned uint16 samples (14-bit code << 2, full scale
 * 0xfffc), but a real detector signal usually occupies a small part of that
 * range (e.g. 0x8090..0xba90). OBI's image view therefore has a histogram +
 * gradient bar with two draggable levels: everything at or below the black
 * level is black, everything at or above the white level is white. This module
 * holds the pure maths for it so the canvas painter, the wedge widget and the
 * tests share one definition.
 */
/** Same value as scanSamples.OBI_SCAN_FULL_SCALE (kept local so this module has no imports). */
const OBI_SCAN_FULL_SCALE = 0xfffc;
/** Exported for components; same value. */
export const OBI_FULL_SCALE = OBI_SCAN_FULL_SCALE;

/** Histogram resolution (bins between the frame's own min and max). */
export const LEVEL_HISTOGRAM_BINS = 512;
/** Auto levels ignore this share of pixels at each end (outliers, dropouts). */
export const AUTO_LOW_PERCENT = 0.5;
export const AUTO_HIGH_PERCENT = 99.5;
/** Smallest allowed black-to-white distance, in sample units (one 14-bit code = 4). */
export const MIN_LEVEL_GAP = 4;

export type LevelSetting =
  | { mode: "auto" }
  | { mode: "manual"; low: number; high: number };

export const AUTO_LEVELS: LevelSetting = { mode: "auto" };

export interface LevelHistogram {
  /** Lowest / highest sample seen (sample units). */
  min: number;
  max: number;
  /** Pixels counted. */
  total: number;
  /** Counts evenly spaced over [min, max] (LEVEL_HISTOGRAM_BINS unless built with another bin count). */
  bins: Uint32Array;
}

export interface ResolvedLevels {
  low: number;
  high: number;
}

/** Convert a sample to the 14-bit ADC code shown on the wedge axis. */
export function sampleToCode(value: number, divisor: number = 4): number {
  return Math.round(value / divisor);
}

export function codeToSample(code: number, divisor: number = 4): number {
  return code * divisor;
}

export function emptyHistogram(): LevelHistogram {
  return { min: 0, max: 0, total: 0, bins: new Uint32Array(LEVEL_HISTOGRAM_BINS) };
}

/**
 * Build a histogram over the frame's own range. `forEach` must visit every
 * counted sample exactly once; it is called once (the caller has already
 * measured min/max in its own first pass).
 */
export function buildHistogram(
  min: number,
  max: number,
  total: number,
  forEach: (visit: (value: number) => void) => void,
  binCount: number = LEVEL_HISTOGRAM_BINS,
): LevelHistogram {
  const count = Math.max(1, Math.floor(binCount));
  const bins = new Uint32Array(count);
  if (total <= 0 || !(max >= min)) {
    return { min: 0, max: 0, total: 0, bins };
  }
  const span = max - min;
  const scale = span > 0 ? (count - 1) / span : 0;
  forEach((value) => {
    bins[Math.min(count - 1, Math.max(0, Math.floor((value - min) * scale)))]++;
  });
  return { min, max, total, bins };
}

/** Sample value below which `percent` % of the counted pixels lie. */
export function histogramPercentile(hist: LevelHistogram, percent: number): number {
  if (hist.total <= 0) return 0;
  const span = hist.max - hist.min;
  if (span <= 0) return hist.min;
  const target = (Math.min(100, Math.max(0, percent)) / 100) * hist.total;
  const binCount = hist.bins.length;
  const binWidth = span / Math.max(1, binCount - 1);
  let cumulative = 0;
  for (let i = 0; i < binCount; i++) {
    const count = hist.bins[i];
    if (cumulative + count >= target && count > 0) {
      const within = (target - cumulative) / count;
      // Bin i holds samples in [min + i*w, min + (i+1)*w).
      return Math.min(hist.max, Math.max(hist.min, hist.min + (i + within) * binWidth));
    }
    cumulative += count;
  }
  return hist.max;
}

function clampSample(value: number, fullScale: number): number {
  return Math.min(fullScale, Math.max(0, value));
}

/** Keep low < high by at least MIN_LEVEL_GAP inside 0..full scale. */
export function normalizeLevels(
  low: number,
  high: number,
  fullScale: number = OBI_SCAN_FULL_SCALE,
): ResolvedLevels {
  let lo = clampSample(Number.isFinite(low) ? low : 0, fullScale);
  let hi = clampSample(Number.isFinite(high) ? high : fullScale, fullScale);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (hi - lo < MIN_LEVEL_GAP) {
    if (lo + MIN_LEVEL_GAP <= fullScale) hi = lo + MIN_LEVEL_GAP;
    else lo = hi - MIN_LEVEL_GAP;
  }
  return { low: lo, high: hi };
}

/**
 * Effective black/white levels for a frame.
 *
 * Auto trims the darkest/brightest 0.5 % so a few dropout or saturated pixels
 * (black scan lines, hot pixels) cannot compress the whole image into a narrow
 * gray band; manual uses the operator's wedge setting.
 */
export function resolveLevels(
  hist: LevelHistogram,
  setting: LevelSetting,
  fullScale: number = OBI_SCAN_FULL_SCALE,
): ResolvedLevels {
  if (setting.mode === "manual") return normalizeLevels(setting.low, setting.high, fullScale);
  if (hist.total <= 0) return { low: 0, high: fullScale };
  let lo = histogramPercentile(hist, AUTO_LOW_PERCENT);
  let hi = histogramPercentile(hist, AUTO_HIGH_PERCENT);
  if (hi - lo < MIN_LEVEL_GAP) {
    lo = hist.min;
    hi = hist.max;
  }
  return normalizeLevels(lo, hi, fullScale);
}

/** Gray (0..255) for a sample with the given levels. */
export function levelGray(value: number, low: number, high: number): number {
  if (value <= low) return 0;
  if (value >= high) return 255;
  return Math.round(((value - low) * 255) / (high - low));
}

/**
 * Axis range of the wedge: the frame's data with 25 % headroom each side, so
 * the handles can be pulled past the data. It depends only on the data, never
 * on the levels, so it stays put while a handle is dragged.
 */
export function wedgeDomain(
  hist: LevelHistogram,
  levels: ResolvedLevels,
  fullScale: number = OBI_SCAN_FULL_SCALE,
): { min: number; max: number } {
  const dataMin = hist.total > 0 ? hist.min : levels.low;
  const dataMax = hist.total > 0 ? hist.max : levels.high;
  const span = Math.max(dataMax - dataMin, 64 * MIN_LEVEL_GAP);
  const pad = span * 0.25;
  const mid = (dataMin + dataMax) / 2;
  let min = Math.max(0, mid - span / 2 - pad);
  let max = Math.min(fullScale, mid + span / 2 + pad);
  if (max - min < MIN_LEVEL_GAP) max = min + MIN_LEVEL_GAP;
  return { min, max };
}

/** 0 at the bottom of the wedge, 1 at the top. */
export function valueToFraction(value: number, domain: { min: number; max: number }): number {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - domain.min) / span));
}

export function fractionToValue(fraction: number, domain: { min: number; max: number }): number {
  const f = Math.min(1, Math.max(0, fraction));
  return domain.min + f * (domain.max - domain.min);
}

/** "Nice" tick positions (in 14-bit ADC codes) covering the domain. */
export function niceCodeTicks(
  domain: { min: number; max: number },
  target = 7,
  divisor: number = 4,
): number[] {
  const lo = sampleToCode(domain.min, divisor);
  const hi = sampleToCode(domain.max, divisor);
  const span = Math.max(1, hi - lo);
  const rough = span / Math.max(2, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  const step = (residual >= 5 ? 5 : residual >= 2 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}

/**
 * Move one handle (or both, for a region drag) and return the new manual
 * levels. `kind` is which handle the pointer holds.
 */
export function dragLevels(
  kind: "low" | "high" | "region",
  start: ResolvedLevels,
  pointerValue: number,
  grabOffset: number,
  fullScale: number = OBI_SCAN_FULL_SCALE,
): ResolvedLevels {
  if (kind === "low") {
    return normalizeLevels(
      Math.min(pointerValue - grabOffset, start.high - MIN_LEVEL_GAP),
      start.high,
      fullScale,
    );
  }
  if (kind === "high") {
    return normalizeLevels(
      start.low,
      Math.max(pointerValue - grabOffset, start.low + MIN_LEVEL_GAP),
      fullScale,
    );
  }
  const width = start.high - start.low;
  let low = pointerValue - grabOffset;
  low = Math.min(fullScale - width, Math.max(0, low));
  return normalizeLevels(low, low + width, fullScale);
}

/* -------- 8-bit gray images (ROI canvas) ------------------------------- */

/**
 * The ROI canvas shows an already rendered 8-bit gray image. One gray level is
 * this many sample units, so the same wedge maths (which works in the 16-bit
 * OBI-aligned sample domain) applies unchanged: gray * 256 == (gray * 64) << 2,
 * the same conversion the server uses for 8-bit bitmaps.
 */
export const ROI_GRAY_SAMPLE_SCALE = 256;
/** Largest sample value of an 8-bit gray image in sample units. */
export const ROI_GRAY_FULL_SCALE = 255 * ROI_GRAY_SAMPLE_SCALE;

/** True for an opaque pixel whose R, G and B are equal (a plain gray pixel). */
function isOpaqueGray(data: ArrayLike<number>, p: number): boolean {
  return data[p + 3] !== 0 && data[p] === data[p + 1] && data[p] === data[p + 2];
}

/**
 * Histogram of the gray pixels of an RGBA buffer, one bin per gray level
 * between the darkest and brightest level present (sample units = gray * 256).
 * Coloured pixels (annotations, highlight tints) and transparent pixels are
 * not counted.
 */
export function grayHistogram(rgba: ArrayLike<number>): LevelHistogram {
  let lo = 255;
  let hi = 0;
  let total = 0;
  for (let p = 0; p + 3 < rgba.length; p += 4) {
    if (!isOpaqueGray(rgba, p)) continue;
    const g = rgba[p];
    if (g < lo) lo = g;
    if (g > hi) hi = g;
    total++;
  }
  if (total === 0) return emptyHistogram();
  return buildHistogram(
    lo * ROI_GRAY_SAMPLE_SCALE,
    hi * ROI_GRAY_SAMPLE_SCALE,
    total,
    (visit) => {
      for (let p = 0; p + 3 < rgba.length; p += 4) {
        if (isOpaqueGray(rgba, p)) visit(rgba[p] * ROI_GRAY_SAMPLE_SCALE);
      }
    },
    hi - lo + 1,
  );
}

/** Lookup table: source gray (0..255) -> displayed gray for the given levels. */
export function grayLevelLut(levels: ResolvedLevels): Uint8Array {
  const lut = new Uint8Array(256);
  for (let g = 0; g < 256; g++) {
    lut[g] = levelGray(g * ROI_GRAY_SAMPLE_SCALE, levels.low, levels.high);
  }
  return lut;
}

export function isIdentityLut(lut: ArrayLike<number>): boolean {
  for (let g = 0; g < 256; g++) if (lut[g] !== g) return false;
  return true;
}

/** Remap the gray pixels of an RGBA buffer in place; coloured pixels are left alone. */
export function applyGrayLut(rgba: Uint8ClampedArray | Uint8Array, lut: ArrayLike<number>): void {
  for (let p = 0; p + 3 < rgba.length; p += 4) {
    if (!isOpaqueGray(rgba, p)) continue;
    const g = lut[rgba[p]];
    rgba[p] = g;
    rgba[p + 1] = g;
    rgba[p + 2] = g;
  }
}
