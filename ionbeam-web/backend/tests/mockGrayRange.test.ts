import test from "node:test";
import assert from "node:assert/strict";
import { stepTargetBitmap, streamMockVector } from "../src/mockHardware.js";

const roi = { x_start: 0, x_end: 3, y_start: 0, y_end: 1 };
const make = () => ({ width: 4, height: 1, source_roi: roi,
  pixels: [40, 100, 140, { value: 200, isSkipped: true }] as Array<number | { value: number; isSkipped?: boolean }> });
const values = (b: ReturnType<typeof make>) => b.pixels.map(p => typeof p === "number" ? p : p.value);

test("Spot range filter mills only pixels inside the range", () => {
  const bitmap = make();
  stepTargetBitmap(bitmap as any, roi, 120, [120, 255], false);
  assert.deepEqual(values(bitmap), [40, 100, 138, 200], "outside-range and outside-pattern pixels are untouched");
});

test("dark range [min, avg] brightens dark pixels toward the average", () => {
  const bitmap = make();
  stepTargetBitmap(bitmap as any, roi, 120, [40, 120], false);
  assert.deepEqual(values(bitmap), [42, 102, 140, 200]);
});

test("Skip range filter mills pixels outside the range", () => {
  const bitmap = make();
  stepTargetBitmap(bitmap as any, roi, 100, [0, 100], true);
  assert.deepEqual(values(bitmap), [40, 100, 138, 200]);
});

test("without a range every non-skipped pixel above the target is milled as before", () => {
  const bitmap = make();
  stepTargetBitmap(bitmap as any, roi, 100);
  assert.deepEqual(values(bitmap), [40, 100, 138, 200], "pixels already marked skipped (outside the pattern) stay untouched");
});


test("Spot streams emit changed gray levels and preserve excluded pixels", async () => {
  for (const [range, target, points, expected] of [
    [[40, 120], 120, [[0, 0, 2, false], [16383, 0, 2, true]], [120 << 8, 0]],
    [[120, 200], 120, [[0, 0, 2, true], [16383, 0, 2, false]], [0, 120 << 8]],
  ] as const) {
    const bitmap = { width: 2, height: 1, source_roi: { x_start: 0, x_end: 16383, y_start: 0, y_end: 1 },
      pixels: [{ value: 40, isSkipped: false }, { value: 200, isSkipped: false }] };
    const chunks: Buffer[] = [];
    const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0,
      send(data: unknown) { if (Buffer.isBuffer(data)) chunks.push(Buffer.from(data)); } };
    await streamMockVector(socket as any, { pattern: "custom", points: points.map(p => [...p]),
      roi: bitmap.source_roi, simulation_bitmap: bitmap, dwell: 2, latency_bytes: 4096,
      continuous: true, frames: 42, target_gray_level: target,
      gray_level_range: [...range], gray_level_skipped: false } as any);
    const final = chunks.at(-1)!;
    assert.deepEqual([final.readUInt16BE(0), final.readUInt16BE(2)], expected);
    const untouched = range[0] === 40 ? 1 : 0;
    assert.equal(bitmap.pixels[untouched].value, untouched === 1 ? 200 : 40);
    assert.ok(bitmap.pixels.every(p => p.isSkipped === false), "reaching target must not hide the final gray reading");
  }
});


test("dark then bright converges every ROI pixel exactly to its frozen average", () => {
  const bitmap = { width: 6, height: 1, source_roi: roi,
    pixels: [0, 39, 100, 161, 200, { value: 255, isSkipped: true }] };
  // Average of the five included pixels is 100; outside-pattern 255 is excluded.
  for (const range of [[0, 100], [100, 255]] as [number, number][]) {
    for (let pass = 0; pass < 130; pass++) stepTargetBitmap(bitmap, roi, 100, range, false);
  }
  assert.deepEqual(bitmap.pixels, [100, 100, 100, 100, 100, { value: 255, isSkipped: true }]);
});
