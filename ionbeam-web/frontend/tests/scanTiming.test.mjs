import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateRevC3ScanTiming,
  formatDuration,
  formatNanoseconds,
  revC3DwellPresetOptions,
  samplesPerPixel,
} from "../.test-dist/lib/scanTiming.js";

test("one ADC conversion follows the 48 MHz clock and upstream six-cycle period", () => {
  const timing = estimateRevC3ScanTiming(1024, 1);
  assert.ok(Math.abs(timing.samplePeriodNs - (1e9 / 8_000_000)) < 1e-6);
});

test("a dwell of N averages N + 1 samples (the gateware emits dwell_time + 1)", () => {
  assert.deepEqual([0, 1, 3, 7, 15].map(samplesPerPixel), [1, 2, 4, 8, 16]);
  const timing = estimateRevC3ScanTiming(1024, 1);
  assert.equal(timing.samplesPerPixel, 2);
  assert.ok(Math.abs(timing.pixelDwellNs - 250) < 1e-6, "dwell 1 is 2 x 125 ns");
  assert.ok(Math.abs(timing.pixelRate - 4_000_000) < 1e-6, "dwell 1 is 4 MPix/s, not 8");
  assert.equal(timing.pixelCount, 1_048_576);
  assert.ok(Math.abs(timing.frameSeconds - (1_048_576 / 4_000_000)) < 1e-9);
});

test("the fastest pixel, one sample, is dwell 0", () => {
  const timing = estimateRevC3ScanTiming(256, 0);
  assert.equal(timing.samplesPerPixel, 1);
  assert.ok(Math.abs(timing.pixelRate - 8_000_000) < 1e-6);
});

test("revC3 timing responds to dwell and resolution", () => {
  const timing = estimateRevC3ScanTiming(2048, 16);
  assert.equal(timing.samplesPerPixel, 17);
  assert.ok(Math.abs(timing.pixelDwellNs - 17 * 125) < 1e-6);
  assert.ok(Math.abs(timing.frameSeconds - (2048 * 2048 * 17 / 8_000_000)) < 1e-9);
  assert.equal(formatNanoseconds(timing.pixelDwellNs), "2.13 µs");
  assert.equal(formatDuration(timing.frameSeconds), "8.91 s");
});

test("dwell presets are 2^k - 1 so no sample is wasted by the power-of-two averager", () => {
  const options = revC3DwellPresetOptions();
  assert.deepEqual(options.map((o) => o.value), [1, 3, 7, 15, 31, 63]);
  assert.equal(options[0].label, "1 — 2 samples/pixel — 250.0 ns — 4.0 MPix/s");
  for (const option of options) {
    const samples = option.value + 1;
    assert.ok(Number.isInteger(Math.log2(samples)), `${option.value} -> ${samples} samples`);
    assert.ok(option.label.includes(`${samples} samples/pixel`));
  }
});

test("timing follows the runtime JSON half-period for diagnostic profiles", () => {
  assert.equal(estimateRevC3ScanTiming(128, 1, 12).samplePeriodNs, 500);
  assert.equal(estimateRevC3ScanTiming(128, 1, 12).pixelDwellNs, 1000);
});
