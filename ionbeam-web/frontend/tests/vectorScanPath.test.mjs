import test from "node:test";
import assert from "node:assert/strict";

import {
  bitmapScanCoordinates,
  vectorScanSampleCount,
  vectorScanSamplePixel,
} from "../.test-dist/lib/vectorScanPath.js";

function pixels(path, edge = 3) {
  return Array.from({ length: vectorScanSampleCount(edge, path) }, (_, index) =>
    vectorScanSamplePixel(index, edge, path),
  );
}

test("maps all production vector scan paths to their traversal order", () => {
  assert.deepEqual(pixels("vertical_raster"), [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 },
    { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 },
  ]);
  assert.deepEqual(pixels("vertical_serpentine"), [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
    { x: 1, y: 2 }, { x: 1, y: 1 }, { x: 1, y: 0 },
    { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 },
  ]);
  assert.deepEqual(pixels("horizontal_sawtooth"), [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ]);
  assert.deepEqual(pixels("horizontal_triangle"), [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
    { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ]);
});

test("orders rectangular ROI bitmap points by the selected scan path", () => {
  assert.deepEqual(Array.from(bitmapScanCoordinates(2, 3, "vertical_serpentine")), [
    [0, 0], [0, 1], [0, 2],
    [1, 2], [1, 1], [1, 0],
  ]);
  assert.deepEqual(Array.from(bitmapScanCoordinates(3, 2, "horizontal_triangle")), [
    [0, 0], [1, 0], [2, 0],
    [2, 1], [1, 1], [0, 1],
  ]);
});
