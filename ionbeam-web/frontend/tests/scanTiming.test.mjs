import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateRevC3ScanTiming,
  formatDuration,
  formatNanoseconds,
} from "../.test-dist/lib/scanTiming.js";

test("revC3 dwell timing follows the 48 MHz clock and safe eight-cycle period", () => {
  const timing = estimateRevC3ScanTiming(1024, 1);
  assert.ok(Math.abs(timing.samplePeriodNs - (1e9 / 6_000_000)) < 1e-6);
  assert.ok(Math.abs(timing.pixelRate - 6_000_000) < 1e-6);
  assert.equal(timing.pixelCount, 1_048_576);
  assert.ok(Math.abs(timing.frameSeconds - (1_048_576 / 6_000_000)) < 1e-9);
});

test("revC3 timing responds to dwell and resolution", () => {
  const timing = estimateRevC3ScanTiming(2048, 16);
  assert.ok(Math.abs(timing.pixelDwellNs - (16e9 / 6_000_000)) < 1e-6);
  assert.ok(Math.abs(timing.frameSeconds - (2048 * 2048 * 16 / 6_000_000)) < 1e-9);
  assert.equal(formatNanoseconds(timing.pixelDwellNs), "2.67 µs");
  assert.equal(formatDuration(timing.frameSeconds), "11.2 s");
});
