import test from "node:test";
import assert from "node:assert/strict";

import { estimateTakeover, conversionHz } from "../.test-dist/lib/takeoverTiming.js";

test("conversions run at 8 MHz on the revC3 gateware", () => {
  assert.equal(conversionHz(), 8_000_000);
});

test("takeover = switch in + N frames + switch out", () => {
  // 1024 x 1024 at dwell 7: 8 conversions of 125 ns = 1 us per pixel.
  const e = estimateTakeover({ framePixels: 1024 * 1024, dwell: 7, frames: 3, frameBlank: true });
  assert.ok(Math.abs(e.frameSeconds - 1.048576) < 1e-9);
  assert.ok(Math.abs(e.scanSeconds - 3 * 1.048576) < 1e-9);
  assert.equal(e.switchSeconds, 0.04);
  assert.ok(Math.abs(e.totalSeconds - (3 * 1.048576 + 0.04)) < 1e-9);
});

test("frame blank changes the beam between frames, not the time held", () => {
  const plan = { framePixels: 512 * 512, dwell: 15, frames: 5 };
  const on = estimateTakeover({ ...plan, frameBlank: true });
  const off = estimateTakeover({ ...plan, frameBlank: false });
  assert.equal(on.totalSeconds, off.totalSeconds);
  assert.equal(on.frameBlank, true);
  assert.equal(off.frameBlank, false);
});

test("the configured switch delay is used", () => {
  const e = estimateTakeover({ framePixels: 100, dwell: 0, frames: 1, frameBlank: false, switchDelayMs: 35 });
  assert.equal(e.switchSeconds, 0.07);
});

test("Infinite has no end time", () => {
  const e = estimateTakeover({ framePixels: 100, dwell: 0, frames: null, frameBlank: true });
  assert.equal(e.totalSeconds, null);
  assert.equal(e.scanSeconds, null);
  assert.ok(e.frameSeconds > 0);
});

test("the plan follows the scan Run would start", async () => {
  const { takeoverPlanForScan } = await import("../.test-dist/lib/takeoverTiming.js");
  const base = {
    raster: { resolution: 512, dwell: 3, frame_blank: false },
    vector: { pattern: "default", vector_resolution: 256, scan_path: "horizontal_sawtooth", points: null, dwell: 16 },
    defaultFrameBlank: true,
    switchDelayMs: 20,
  };
  const raster = takeoverPlanForScan({ ...base, kind: "raster" });
  assert.deepEqual([raster.framePixels, raster.dwell, raster.frames, raster.frameBlank], [512 * 512, 3, 1, false]);
  const vector = takeoverPlanForScan({ ...base, kind: "vector" });
  assert.deepEqual([vector.framePixels, vector.dwell, vector.frames, vector.frameBlank], [256 * 256, 16, 1, true]);
  const custom = takeoverPlanForScan({ ...base, kind: "vector", vector: { ...base.vector, pattern: "custom", points: new Array(1234) } });
  assert.equal(custom.framePixels, 1234);
  assert.equal(takeoverPlanForScan({ ...base, kind: "vector", infinite: true }).frames, null);
});

test("takeover happens exactly when scans use the hardware (service rule)", async () => {
  const { scansUseHardware } = await import("../.test-dist/lib/takeoverTiming.js");
  assert.equal(scansUseHardware(true, { enabled: true }), true);    // production always
  assert.equal(scansUseHardware(undefined, null), true);            // defaults not loaded: production
  assert.equal(scansUseHardware(false, null), false);               // simulation on by default
  assert.equal(scansUseHardware(false, {}), false);
  assert.equal(scansUseHardware(false, { enabled: true }), false);
  assert.equal(scansUseHardware(false, { enabled: false }), true);  // bench: simulation off
});
