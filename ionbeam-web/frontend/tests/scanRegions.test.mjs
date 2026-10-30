import test from "node:test";
import assert from "node:assert/strict";

import {
  clampScanZoom,
  effectiveScanRegions,
  mapScanPixelIndexToFrame,
  scanRegionPixelBounds,
  zoomScanRegion,
  zoomVectorPoints,
  zoomInterleavedVectorPoints,
} from "../.test-dist/lib/scanRegions.js";
import imageReducer, {
  appendRaster,
  appendVectorSamples,
  queueLiveScanDisplay,
  resetRaster,
  setLiveVectorCustomPoints,
  setupVector,
} from "../.test-dist/store/imageSlice.js";
import { decorateSimulationBitmap } from "../.test-dist/lib/bitmapVector.js";

const fov = { x_origin: 0, x_end: 100, y_origin: -50, y_end: 50 };

test("scan zoom is bounded and applies around the full-FOV centre", () => {
  assert.equal(clampScanZoom(0), 1);
  assert.equal(clampScanZoom(2.9), 2);
  assert.equal(clampScanZoom(5000), 5000);
  assert.equal(clampScanZoom(20000), 20000);
  assert.equal(clampScanZoom(20001), 20000);
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

test("zoom uses the applied magnification table to map physical FOV", () => {
  const calibratedFov = {
    ...fov,
    scanGeometry: {
      enabled: true,
      magnification: 1000,
      magnificationCalibration: { 1000: 100e-6, 2000: 40e-6 },
    },
  };
  assert.deepEqual(zoomScanRegion(null, 2, calibratedFov), {
    x_start: 30,
    x_end: 70,
    y_start: -20,
    y_end: 20,
  });
  assert.deepEqual(zoomScanRegion(null, 2, fov), {
    x_start: 25,
    x_end: 75,
    y_start: -25,
    y_end: 25,
  });
});

test("live custom zoom changes only point coordinates", () => {
  const from = { x_start: 0, x_end: 100, y_start: 0, y_end: 100 };
  const to = { x_start: 25, x_end: 75, y_start: 25, y_end: 75 };
  const points = [[0, 100, 2, true, 2], { x: 100, y: 0, dwell: 5, blank: false, passIndex: 1 }];
  assert.deepEqual(zoomVectorPoints(points, from, to), [
    [25, 75, 2, true, 2],
    { x: 75, y: 25, dwell: 5, blank: false, passIndex: 1 },
  ]);
});

test("parallel custom zoom keeps interleaved point order", () => {
  const first = { x_start: 0, x_end: 100, y_start: 0, y_end: 100 };
  const second = { x_start: 200, x_end: 300, y_start: 200, y_end: 300 };
  const points = [[0, 0, 2], [200, 200, 3], [100, 100, 4]];
  assert.deepEqual(zoomInterleavedVectorPoints(points, [2, 1], [first, second], [
    { x_start: 25, x_end: 75, y_start: 25, y_end: 75 },
    { x_start: 225, x_end: 275, y_start: 225, y_end: 275 },
  ]), [[25, 25, 2], [225, 225, 3], [75, 75, 4]]);
});

test("live custom point update keeps image and blank flags", () => {
  let state = imageReducer(undefined, { type: "test/init" });
  state = imageReducer(state, setupVector({
    pattern: "custom", edge: 4, continuous: true,
    points: [[0, 0, 2, true], [100, 100, 3, false]],
  }));
  state = imageReducer(state, appendVectorSamples({ values: Uint16Array.of(10, 20) }));
  const beforeImage = [...state.vectorImage];
  const beforeRender = [...state.vectorCustomRenderPoints];
  const beforeBlank = [...state.vectorCustomBlankMask];
  state = imageReducer(state, setLiveVectorCustomPoints([[25, 25, 2, true], [75, 75, 3, false]]));
  assert.deepEqual([...state.vectorImage], beforeImage);
  assert.deepEqual([...state.vectorCustomRenderPoints], beforeRender);
  assert.deepEqual([...state.vectorCustomBlankMask], beforeBlank);
  assert.deepEqual([...state.vectorCustomPoints], [25, 25, 75, 75]);
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

test("live ROI display move waits for the next vector pass", () => {
  const full = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const oldROI = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  const nextROI = { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 };
  let state = imageReducer(undefined, { type: "test/init" });
  state = imageReducer(state, setupVector({
    pattern: "default", edge: 4, continuous: true,
    parallelROIs: [full, oldROI], compositeROIs: [oldROI],
  }));
  state = imageReducer(state, appendVectorSamples({ values: Uint16Array.of(10, 20) }));
  state = imageReducer(state, queueLiveScanDisplay({
    kind: "vector",
    display: { roi: null, parallelROIs: [full, nextROI], compositeROIs: [nextROI] },
  }));
  assert.deepEqual(state.vectorParallelROIs[1], oldROI);
  state = imageReducer(state, appendVectorSamples({ values: new Uint16Array(30) }));
  assert.equal(state.vectorPasses, 1);
  assert.deepEqual(state.vectorParallelROIs[1], nextROI);
});

test("filtered live zoom refreshes blanked pixels when returning from 2 to 1", () => {
  const full = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const roi = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  let state = imageReducer(undefined, setupVector({
    pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
    continuous: true, preserveZeroSamples: true,
    parallelROIs: [full, roi], compositeROIs: [roi],
    initialImage: new Uint16Array(16).fill(100),
  }));
  const pass = Uint16Array.from({ length: 32 }, (_, index) => index % 2 ? 0 : 100);
  const display = { roi: null, parallelROIs: [full, roi], compositeROIs: [roi] };
  // Begin a pass, then change zoom: the new underlay must wait for its end.
  state = imageReducer(state, appendVectorSamples({ values: pass.slice(0, 2) }));
  state = imageReducer(state, queueLiveScanDisplay({ kind: "vector", display: {
    ...display, initialImage: new Uint16Array(16).fill(200),
  } }));
  assert.equal(state.vectorImage[0], 100);
  state = imageReducer(state, appendVectorSamples({ values: pass.slice(2) }));
  assert.equal(state.vectorImage[0], 200);
  state = imageReducer(state, appendVectorSamples({ values: pass }));
  assert.equal(state.vectorImage[0], 200, "filtered samples retain the zoom-2 underlay");
  state = imageReducer(state, queueLiveScanDisplay({ kind: "vector", display: {
    ...display, initialImage: new Uint16Array(16).fill(50),
  } }));
  state = imageReducer(state, appendVectorSamples({ values: pass }));
  state = imageReducer(state, appendVectorSamples({ values: pass }));
  assert.deepEqual([...state.vectorImage], [
    50, 50, 100, 100,
    50, 50, 100, 100,
    100, 100, 100, 100,
    100, 100, 100, 100,
  ]);
  assert.equal(state.vectorPasses, 4);
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

test("composite raster keeps normal full-field samples outside a zoomed ROI", () => {
  const full = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const roi = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  let state = imageReducer(undefined, resetRaster({
    resolution: 4, parallelROIs: [full, roi], compositeROIs: [roi],
  }));
  state = imageReducer(state, appendRaster({
    pixels: Uint16Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? 100 : 200),
  }));
  assert.deepEqual([...state.frame], [
    200, 200, 100, 100,
    200, 200, 100, 100,
    100, 100, 100, 100,
    100, 100, 100, 100,
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

test("composite vector keeps normal full-field samples outside a zoomed ROI", () => {
  const full = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const roi = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  let state = imageReducer(undefined, setupVector({
    pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
    parallelROIs: [full, roi], compositeROIs: [roi],
  }));
  state = imageReducer(state, appendVectorSamples({
    values: Uint16Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? 100 : 200),
  }));
  assert.deepEqual([...state.vectorImage], [
    200, 200, 100, 100,
    200, 200, 100, 100,
    100, 100, 100, 100,
    100, 100, 100, 100,
  ]);
});

test("composite scan keeps the full field outside every selected ROI", () => {
  const full = { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const first = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  const second = { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 };
  const regions = [full, first, second];
  const values = Uint16Array.from({ length: 48 }, (_, index) => [100, 200, 300][index % 3]);
  let raster = imageReducer(undefined, resetRaster({ resolution: 4, parallelROIs: regions, compositeROIs: [first, second] }));
  raster = imageReducer(raster, appendRaster({ pixels: values }));
  let vector = imageReducer(undefined, setupVector({
    pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
    parallelROIs: regions, compositeROIs: [first, second],
  }));
  vector = imageReducer(vector, appendVectorSamples({ values }));
  const expected = [
    200, 200, 100, 100,
    200, 200, 100, 100,
    100, 100, 300, 300,
    100, 100, 300, 300,
  ];
  assert.deepEqual([...raster.frame], expected);
  assert.deepEqual([...vector.vectorImage], expected);
  assert.deepEqual([...vector.vectorCompositeMask], [
    1, 1, 0, 0,
    1, 1, 0, 0,
    0, 0, 1, 1,
    0, 0, 1, 1,
  ]);
});

test("ROI gray filtering keeps the full-field simulation source undecorated", () => {
  const background = decorateSimulationBitmap({ width: 2, height: 1, pixels: [220, 240] }, null, null);
  const filteredROI = decorateSimulationBitmap(background, [219, 255], false);
  assert.deepEqual(background.pixels, [220, 240]);
  assert.deepEqual(filteredROI.pixels.map((pixel) => pixel.isHighlighted), [true, true]);
});

test("sequential vector background refresh leaves the zoomed ROI untouched", () => {
  const roi = { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 };
  let state = imageReducer(undefined, setupVector({
    pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
    compositeROIs: [roi], initialImage: new Uint16Array(16).fill(200),
  }));
  state = imageReducer(state, appendVectorSamples({ values: new Uint16Array(16).fill(100) }));
  assert.deepEqual([...state.vectorImage], [
    200, 200, 100, 100,
    200, 200, 100, 100,
    100, 100, 100, 100,
    100, 100, 100, 100,
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
