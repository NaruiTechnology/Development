import test from "node:test";
import assert from "node:assert/strict";

import { decorateSimulationBitmap, interleaveParallelPoints } from "../.test-dist/lib/bitmapVector.js";
import { prepareScanAssets } from "../.test-dist/lib/scanAssets.js";

test("scan asset preparation preserves IDs loaded from a persisted queue", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("existing IDs must not trigger an upload"); };
  try {
    const prepared = await prepareScanAssets({
      simulation_bitmap: null,
      simulation_bitmap_id: "single-asset",
      parallel_simulation_bitmaps: null,
      parallel_simulation_bitmap_ids: ["roi-a", "roi-b"],
    });
    assert.equal(prepared.simulation_bitmap_id, "single-asset");
    assert.deepEqual(prepared.parallel_simulation_bitmap_ids, ["roi-a", "roi-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("custom points from parallel ROIs are sent in round-robin order", () => {
  assert.deepEqual(interleaveParallelPoints([["a0", "a1", "a2"], ["b0", "b1"]]), [
    "a0", "b0", "a1", "b1", "a2",
  ]);
});

test("parallel simulation bitmaps stay below the WebSocket request limit", () => {
  const bitmap = {
    width: 500,
    height: 500,
    pixels: Array.from({ length: 250_000 }, (_, index) => index % 256),
  };
  const decorated = decorateSimulationBitmap(bitmap, null, null);
  const request = { parallel_rois: [{}, {}, {}], parallel_simulation_bitmaps: [decorated, decorated, decorated] };
  assert.equal(typeof decorated.pixels[0], "number");
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 16 * 1024 * 1024);
});

test("gray selection keeps metadata only on highlighted pixels", () => {
  const bitmap = { width: 3, height: 1, pixels: [10, 20, 30] };
  assert.deepEqual(decorateSimulationBitmap(bitmap, [20, 20], true).pixels, [
    10,
    { value: 20, isHighlighted: true, isSkipped: true, blank: true },
    30,
  ]);
  assert.deepEqual(decorateSimulationBitmap(bitmap, [20, 20], false).pixels, [
    10,
    { value: 20, isHighlighted: true, isSkipped: false, blank: false },
    30,
  ]);
});
