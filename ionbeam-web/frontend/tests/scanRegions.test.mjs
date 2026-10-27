import test from "node:test";
import assert from "node:assert/strict";

import {
  clampScanZoom,
  effectiveScanRegions,
  mapScanPixelIndexToFrame,
  scanRegionPixelBounds,
  zoomScanRegion,
} from "../.test-dist/lib/scanRegions.js";
import imageReducer, {
  appendRaster,
  appendVectorSamples,
  resetRaster,
  setupVector,
} from "../.test-dist/store/imageSlice.js";

const fov = { x_origin: 0, x_end: 100, y_origin: -50, y_end: 50 };

test("scan zoom is bounded and applies around the full-FOV centre", () => {
  assert.equal(clampScanZoom(0), 1);
  assert.equal(clampScanZoom(2.9), 2);
  assert.equal(clampScanZoom(5000), 1000);
  assert.deepEqual(zoomScanRegion(null, 2, fov), {
    x_start: 25,
    x_end: 75,
    y_start: -25,
    y_end: 25,
  });
});

test("each selected region receives the same independent zoom", () => {
  const regions = [
    { x_start: 10, x_end: 30, y_start: -40, y_end: -20 },
    { x_start: 60, x_end: 100, y_start: 10, y_end: 30 },
  ];
  assert.deepEqual(effectiveScanRegions(regions, 2, fov), [
    { x_start: 15, x_end: 25, y_start: -35, y_end: -25 },
    { x_start: 70, x_end: 90, y_start: 15, y_end: 25 },
  ]);
  assert.deepEqual(effectiveScanRegions([], 1, fov), [null]);
});

test("DAC ROI samples map back into their full-frame rectangle", () => {
  const bounds = scanRegionPixelBounds(
    { x_start: 0, x_end: 8191, y_start: 8192, y_end: 16383 },
    8,
  );
  assert.deepEqual(bounds, { x0: 0, x1: 4, y0: 4, y1: 8 });
  assert.equal(mapScanPixelIndexToFrame(bounds, 8, 0, 0), 32);
  assert.equal(mapScanPixelIndexToFrame(bounds, 8, 7, 7), 59);
});

test("successive raster ROIs composite into one preserved full-frame buffer", () => {
  let state = imageReducer(undefined, { type: "test/init" });
  state = imageReducer(state, resetRaster({
    resolution: 4,
    roi: { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 },
    initialFrame: new Uint16Array(16).fill(9),
  }));
  state = imageReducer(state, appendRaster({
    pixels: Uint16Array.from({ length: 16 }, (_, index) => index + 1),
  }));

  state = imageReducer(state, resetRaster({
    resolution: 4,
    preserveFrame: true,
    roi: { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 },
  }));
  state = imageReducer(state, appendRaster({
    pixels: Uint16Array.from({ length: 16 }, (_, index) => index + 101),
  }));

  assert.deepEqual([...state.frame], [
    6, 8, 9, 9,
    14, 16, 9, 9,
    9, 9, 106, 108,
    9, 9, 114, 116,
  ]);
});

test("one raster stream composites samples from two parallel ROIs", () => {
  const regions = [
    { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 },
    { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 },
  ];
  let state = imageReducer(undefined, resetRaster({
    resolution: 4, parallelROIs: regions,
    initialFrame: new Uint16Array(16).fill(9),
  }));
  state = imageReducer(state, appendRaster({
    pixels: Uint16Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? 100 : 200),
  }));
  assert.equal(state.cursor, 32);
  assert.deepEqual([...state.frame], [
    100, 100, 9, 9,
    100, 100, 9, 9,
    9, 9, 200, 200,
    9, 9, 200, 200,
  ]);
});

test("one vector stream maps each parallel pass segment to its ROI", () => {
  const regions = [
    { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 },
    { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 },
  ];
  let state = imageReducer(undefined, setupVector({
    pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
    parallelROIs: regions, initialImage: new Uint16Array(16).fill(9),
  }));
  state = imageReducer(state, appendVectorSamples({
    values: Uint16Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? 100 : 200),
  }));
  assert.equal(state.vectorCursor, 32);
  assert.deepEqual([...state.vectorImage], [
    100, 100, 9, 9,
    100, 100, 9, 9,
    9, 9, 200, 200,
    9, 9, 200, 200,
  ]);
});

test("vector ROI rendering preserves the seeded image outside its display area", () => {
  let state = imageReducer(undefined, { type: "test/init" });
  const displayROI = { x_start: 4096, x_end: 12287, y_start: 4096, y_end: 12287 };
  state = imageReducer(state, setupVector({
    pattern: "default",
    scanPath: "horizontal_sawtooth",
    edge: 4,
    roi: { x_start: 7782, x_end: 8601, y_start: 7782, y_end: 8601 },
    displayROI,
    initialImage: new Uint16Array(16).fill(77),
  }));
  state = imageReducer(state, appendVectorSamples({
    values: Uint16Array.from({ length: 16 }, (_, index) => index + 1),
  }));

  assert.deepEqual(state.vectorROI, displayROI);
  assert.equal(state.vectorImage[0], 77);
  assert.equal(state.vectorImage[15], 77);
  assert.ok([...state.vectorImage].some((value) => value !== 77));
});

test("three vector ROI scans retain every result and untouched background", () => {
  const edge = 16;
  const regions = [
    { x_start: 1024, x_end: 3071, y_start: 1024, y_end: 3071 },
    { x_start: 5120, x_end: 7167, y_start: 5120, y_end: 7167 },
    { x_start: 10240, x_end: 14335, y_start: 1024, y_end: 3071 },
  ];
  const zoomed = effectiveScanRegions(regions, 2, {x_origin: 0, x_end: 16383, y_origin: 0, y_end: 16383});
  let state = imageReducer(undefined, {type: "test/init"});
  for (let i = 0; i < regions.length; i++) {
    state = imageReducer(state, setupVector({
      pattern: "default", scanPath: "horizontal_sawtooth", edge,
      roi: zoomed[i], displayROI: regions[i], preserveImage: i > 0,
      initialImage: new Uint16Array(edge * edge).fill(77),
    }));
    state = imageReducer(state, appendVectorSamples({values: new Uint16Array(edge * edge).fill((i + 1) * 10000)}));
  }
  const expected = new Uint16Array(edge * edge).fill(77);
  regions.forEach((region, index) => {
    const bounds = scanRegionPixelBounds(region, edge);
    for (let y = bounds.y0; y < bounds.y1; y++) {
      for (let x = bounds.x0; x < bounds.x1; x++) expected[y * edge + x] = (index + 1) * 10000;
    }
  });
  assert.deepEqual(state.vectorImage, expected);
});
