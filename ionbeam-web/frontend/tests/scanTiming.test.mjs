import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateRevC3ScanTiming,
  formatDuration,
  formatNanoseconds,
} from "../.test-dist/lib/scanTiming.js";

test("revC3 dwell timing follows the 48 MHz clock and six-cycle OBI period", () => {
  const timing = estimateRevC3ScanTiming(1024, 1);
  assert.ok(Math.abs(timing.samplePeriodNs - 125) < 1e-6);
  assert.ok(Math.abs(timing.pixelRate - 8_000_000) < 1e-6);
  assert.equal(timing.pixelCount, 1_048_576);
  assert.ok(Math.abs(timing.frameSeconds - 0.131072) < 1e-9);
});

test("revC3 timing responds to dwell and resolution", () => {
  const timing = estimateRevC3ScanTiming(2048, 16);
  assert.ok(Math.abs(timing.pixelDwellNs - 2000) < 1e-6);
  assert.ok(Math.abs(timing.frameSeconds - 8.388608) < 1e-9);
  assert.equal(formatNanoseconds(timing.pixelDwellNs), "2.00 µs");
  assert.equal(formatDuration(timing.frameSeconds), "8.39 s");
});
