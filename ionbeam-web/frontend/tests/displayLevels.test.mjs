import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_LEVELS,
  ROI_GRAY_FULL_SCALE,
  ROI_GRAY_SAMPLE_SCALE,
  applyGrayLut,
  grayHistogram,
  grayLevelLut,
  isIdentityLut,
  MIN_LEVEL_GAP,
  buildHistogram,
  dragLevels,
  fractionToValue,
  histogramPercentile,
  levelGray,
  niceCodeTicks,
  normalizeLevels,
  resolveLevels,
  sampleToCode,
  valueToFraction,
  wedgeDomain,
} from "../.test-dist/lib/displayLevels.js";
import { OBI_SCAN_FULL_SCALE } from "../.test-dist/lib/scanSamples.js";

function histOf(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return buildHistogram(min, max, values.length, (visit) => values.forEach(visit));
}

// A frame like the ones from the bench: background near 0x87xx-0x8bxx, bright
// features up to ~0xb000, plus a few dropout and hot pixels at the extremes.
function benchFrame() {
  const values = [];
  for (let i = 0; i < 20000; i++) values.push(0x8700 + ((i * 37) % 0x500));
  for (let i = 0; i < 4000; i++) values.push(0x9800 + ((i * 53) % 0x1800));
  values.push(0x801c, 0x8094, 0xba98, 0xba58);
  return values;
}

test("histogram counts every sample and spans the frame range", () => {
  const values = benchFrame();
  const h = histOf(values);
  assert.equal(h.total, values.length);
  assert.equal(h.min, 0x801c);
  assert.equal(h.max, 0xba98);
  assert.equal(h.bins.reduce((a, b) => a + b, 0), values.length);
});

test("auto levels trim outliers so the image is not squashed into a gray band", () => {
  const values = benchFrame();
  const h = histOf(values);
  const { low, high } = resolveLevels(h, AUTO_LEVELS);
  assert.ok(low > h.min + 0x300, `low ${low.toString(16)} should sit above the dropout pixels`);
  assert.ok(high < h.max, "high should sit below the hot pixels");
  // Most of the background must render dark, bright features bright.
  const dark = values.filter((v) => levelGray(v, low, high) < 40).length;
  assert.ok(dark / values.length > 0.5, "background should map to the dark end");
  assert.equal(levelGray(0x801c, low, high), 0);
  assert.equal(levelGray(0xba98, low, high), 255);
});

test("plain min/max scaling is what made the old image look washed out", () => {
  const values = benchFrame();
  const h = histOf(values);
  const minMaxGrayOfBackground = levelGray(0x8a00, h.min, h.max);
  const { low, high } = resolveLevels(h, AUTO_LEVELS);
  assert.ok(levelGray(0x8a00, low, high) < minMaxGrayOfBackground,
    "auto levels darken the background compared with min/max");
});

test("percentile is monotonic and bounded", () => {
  const h = histOf(benchFrame());
  let previous = -1;
  for (const p of [0, 1, 10, 50, 90, 99, 100]) {
    const v = histogramPercentile(h, p);
    assert.ok(v >= previous);
    assert.ok(v >= h.min && v <= h.max);
    previous = v;
  }
});

test("constant frames and empty frames do not divide by zero", () => {
  const flat = histOf([0x9000, 0x9000, 0x9000]);
  const r = resolveLevels(flat, AUTO_LEVELS);
  assert.ok(r.high - r.low >= MIN_LEVEL_GAP);
  const empty = buildHistogram(0, 0, 0, () => {});
  assert.deepEqual(resolveLevels(empty, AUTO_LEVELS), { low: 0, high: OBI_SCAN_FULL_SCALE });
  assert.equal(levelGray(5, 5, 5 + MIN_LEVEL_GAP), 0);
});

test("manual levels are used verbatim (clamped and ordered)", () => {
  const h = histOf(benchFrame());
  assert.deepEqual(resolveLevels(h, { mode: "manual", low: 0x8000, high: 0xa000 }),
    { low: 0x8000, high: 0xa000 });
  const swapped = resolveLevels(h, { mode: "manual", low: 0xa000, high: 0x8000 });
  assert.ok(swapped.low < swapped.high);
  const wide = normalizeLevels(-100, 1e9);
  assert.deepEqual(wide, { low: 0, high: OBI_SCAN_FULL_SCALE });
  const same = normalizeLevels(0x9000, 0x9000);
  assert.equal(same.high - same.low, MIN_LEVEL_GAP);
});

test("levelGray maps black to 0, white to 255, mid to ~128", () => {
  assert.equal(levelGray(0x8000, 0x8000, 0xa000), 0);
  assert.equal(levelGray(0xa000, 0x8000, 0xa000), 255);
  const mid = levelGray(0x9000, 0x8000, 0xa000);
  assert.ok(mid >= 127 && mid <= 128);
  assert.equal(levelGray(0x1000, 0x8000, 0xa000), 0);
  assert.equal(levelGray(0xf000, 0x8000, 0xa000), 255);
});

test("wedge domain follows the data, not the levels, and gives headroom", () => {
  const h = histOf(benchFrame());
  const a = wedgeDomain(h, { low: 0x8000, high: 0xa000 });
  const b = wedgeDomain(h, { low: 0x9000, high: 0xb000 });
  assert.deepEqual(a, b);
  assert.ok(a.min < h.min && a.max > h.max);
  assert.ok(a.min >= 0 && a.max <= OBI_SCAN_FULL_SCALE);
});

test("fraction <-> value round trip and clamping", () => {
  const domain = { min: 0x7000, max: 0xc000 };
  for (const v of [0x7000, 0x8123, 0xc000]) {
    assert.ok(Math.abs(fractionToValue(valueToFraction(v, domain), domain) - v) < 1e-6);
  }
  assert.equal(valueToFraction(0x1000, domain), 0);
  assert.equal(valueToFraction(0xf000, domain), 1);
});

test("axis ticks are round 14-bit codes inside the domain", () => {
  const domain = { min: 0x7000, max: 0xc000 };
  const ticks = niceCodeTicks(domain);
  assert.ok(ticks.length >= 3 && ticks.length <= 12, ticks.join(","));
  for (const t of ticks) {
    assert.ok(t >= sampleToCode(domain.min) && t <= sampleToCode(domain.max));
  }
  const step = ticks[1] - ticks[0];
  assert.ok([1, 2, 5].includes(step / 10 ** Math.floor(Math.log10(step))));
});

test("dragging a handle never crosses the other one; region drag keeps its width", () => {
  const start = { low: 0x8000, high: 0xa000 };
  const lowUp = dragLevels("low", start, 0xb000, 0);
  assert.ok(lowUp.low < lowUp.high && lowUp.high === start.high);
  const highDown = dragLevels("high", start, 0x7000, 0);
  assert.ok(highDown.high > highDown.low && highDown.low === start.low);
  const moved = dragLevels("region", start, 0x9000, 0x1000);
  assert.equal(moved.high - moved.low, start.high - start.low);
  const pinned = dragLevels("region", start, 0xffff, 0);
  assert.equal(pinned.high, OBI_SCAN_FULL_SCALE);
  assert.equal(pinned.high - pinned.low, start.high - start.low);
});

function rgbaOf(pixels) {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((px, i) => {
    const [r, g, b, a] = Array.isArray(px) ? px : [px, px, px, 255];
    out.set([r, g, b, a ?? 255], i * 4);
  });
  return out;
}

test("gray histogram: one bin per gray level, colour and transparent pixels ignored", () => {
  const rgba = rgbaOf([100, 100, 101, 105, 105, 105, [255, 0, 0, 255], [40, 40, 40, 0]]);
  const h = grayHistogram(rgba);
  assert.equal(h.total, 6);
  assert.equal(h.min, 100 * ROI_GRAY_SAMPLE_SCALE);
  assert.equal(h.max, 105 * ROI_GRAY_SAMPLE_SCALE);
  assert.equal(h.bins.length, 6);
  assert.deepEqual(Array.from(h.bins), [2, 1, 0, 0, 0, 3]);
  assert.equal(grayHistogram(rgbaOf([[9, 9, 9, 0]])).total, 0);
});

test("gray levels: auto stretches a narrow 8-bit image, LUT is monotonic and clamped", () => {
  const values = [];
  for (let i = 0; i < 4000; i++) values.push(96 + (i % 40)); // narrow gray band
  values.push(0, 255);
  const h = grayHistogram(rgbaOf(values));
  const levels = resolveLevels(h, AUTO_LEVELS, ROI_GRAY_FULL_SCALE);
  assert.ok(levels.low >= 96 * ROI_GRAY_SAMPLE_SCALE - 1 && levels.high <= 136 * ROI_GRAY_SAMPLE_SCALE);
  const lut = grayLevelLut(levels);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 255);
  assert.ok(lut[135] - lut[96] > 200, "the band now spans most of the range");
  for (let g = 1; g < 256; g++) assert.ok(lut[g] >= lut[g - 1]);
  assert.equal(isIdentityLut(grayLevelLut({ low: 0, high: ROI_GRAY_FULL_SCALE })), true);
  assert.equal(isIdentityLut(lut), false);
});

test("applyGrayLut remaps gray pixels only and never touches alpha", () => {
  const lut = new Uint8Array(256).map((_, g) => 255 - g);
  const rgba = rgbaOf([10, [200, 30, 30, 255], [50, 50, 50, 0]]);
  applyGrayLut(rgba, lut);
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [245, 245, 245, 255]);
  assert.deepEqual(Array.from(rgba.slice(4, 8)), [200, 30, 30, 255]);
  assert.deepEqual(Array.from(rgba.slice(8, 12)), [50, 50, 50, 0]);
});

test("gray full scale keeps handles inside 0..255", () => {
  const moved = dragLevels("high", { low: 0, high: 100 * ROI_GRAY_SAMPLE_SCALE }, 1e9, 0, ROI_GRAY_FULL_SCALE);
  assert.equal(moved.high, ROI_GRAY_FULL_SCALE);
  const domain = wedgeDomain(grayHistogram(rgbaOf([0, 255])), { low: 0, high: ROI_GRAY_FULL_SCALE }, ROI_GRAY_FULL_SCALE);
  assert.ok(domain.max <= ROI_GRAY_FULL_SCALE && domain.min >= 0);
  const ticks = niceCodeTicks(domain, 7, ROI_GRAY_SAMPLE_SCALE);
  assert.ok(ticks.every((t) => t >= 0 && t <= 255), ticks.join(","));
});
