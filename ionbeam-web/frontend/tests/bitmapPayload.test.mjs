import test from "node:test";
import assert from "node:assert/strict";

import { decorateSimulationBitmap, interleaveParallelPoints } from "../.test-dist/lib/bitmapVector.js";
import { encodeSimulationBitmap, prepareScanAssets } from "../.test-dist/lib/scanAssets.js";
import { prepareScanSequence } from "../.test-dist/lib/scanQueues.js";
import { targetGrayFilter } from "../.test-dist/lib/roiTargetGray.js";

test("dense gray-filtered asset encoding yields to UI tasks and preserves pixels", async () => {
  const bitmap = decorateSimulationBitmap({ width: 500, height: 500,
    pixels: Array(250_000).fill(140), source_roi: { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 },
  }, [0, 140], true);
  let responsive = false;
  const heartbeat = setTimeout(() => { responsive = true; }, 0);
  try {
    const encoded = await encodeSimulationBitmap(bitmap);
    assert.equal(responsive, true, "UI tasks must run before the asset finishes encoding");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encoded)), bitmap);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(await encodeSimulationBitmap({ width: 0, height: 0, pixels: [] }))),
      { width: 0, height: 0, pixels: [] });
  } finally {
    clearTimeout(heartbeat);
  }
});

test("parallel regions reuse one immutable gray-filtered full-image bitmap", () => {
  const source = { width: 2, height: 1, pixels: [100, 200] };
  assert.equal(decorateSimulationBitmap(source, null, null), source);
  const filtered = decorateSimulationBitmap(source, [0, 140], true);
  assert.equal(decorateSimulationBitmap(source, [0, 140], true), filtered);
  const changed = decorateSimulationBitmap(source, [0, 210], false);
  assert.notEqual(changed, filtered);
  assert.equal(changed.pixels[1].blank, false);
  assert.deepEqual(source.pixels, [100, 200]);
});

test("identical parallel assets upload once with only one preparation in flight", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { hostname: "example.test", port: "" }, localStorage: { getItem: () => null } };
  let calls = 0;
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    const { asset_id } = JSON.parse(options.body);
    return { ok: true, json: async () => ({ asset_id, cached: true }) };
  };
  try {
    const bitmap = { width: 2, height: 1, pixels: [10, 20] };
    const result = await prepareScanAssets({ simulation_bitmap: bitmap,
      parallel_simulation_bitmaps: [bitmap, { ...bitmap, pixels: [10, 20] }, { ...bitmap, pixels: [30, 40] }] });
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal(result.simulation_bitmap_id, result.parallel_simulation_bitmap_ids[0]);
    assert.equal(result.parallel_simulation_bitmap_ids[0], result.parallel_simulation_bitmap_ids[1]);
    assert.notEqual(result.parallel_simulation_bitmap_ids[1], result.parallel_simulation_bitmap_ids[2]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});

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

test("sequential Live repeats reuse prepared asset IDs and retain bitmap display metadata", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { hostname: "example.test", port: "" }, localStorage: { getItem: () => null } };
  let preparations = 0;
  globalThis.fetch = async (_url, options) => {
    preparations++;
    const { asset_id } = JSON.parse(options.body);
    return { ok: true, json: async () => ({ asset_id, cached: true }) };
  };
  try {
    const initialFrame = Uint16Array.of(10, 20);
    const entries = await prepareScanSequence([{ kind: "raster", displayROI: null, initialFrame,
      req: { simulation_bitmap: { width: 2, height: 1, pixels: [10, 20] } } }]);
    assert.equal(preparations, 1);
    assert.equal(entries[0].req.simulation_bitmap, null);
    assert.ok(entries[0].req.simulation_bitmap_id);
    assert.equal(entries[0].hasSimulationBitmap, true);
    assert.deepEqual(entries[0].simulationBitmapInfo, { width: 2, height: 1 });
    assert.equal(entries[0].initialFrame, initialFrame);
    for (let pass = 0; pass < 5; pass++) await prepareScanAssets(entries[0].req);
    assert.equal(preparations, 1, "repeated passes must not re-encode or upload the bitmap");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
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

test("target Skip blanks pixels at or below the threshold inside the ROI bitmap", () => {
  const source = { width: 3, height: 1, pixels: [38, 39, 40] };
  const { selection, skipped } = targetGrayFilter(39);
  const roi = decorateSimulationBitmap(source, selection, skipped);
  assert.deepEqual(roi.pixels, [
    { value: 38, isHighlighted: true, isSkipped: true, blank: true },
    { value: 39, isHighlighted: true, isSkipped: true, blank: true },
    40,
  ]);
  assert.deepEqual(source.pixels, [38, 39, 40], "the full-field source remains unfiltered");
});
