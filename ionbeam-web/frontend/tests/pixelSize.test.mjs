import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPixelSize,
  isotropicPixelSizeFromMetres,
  pixelSizeFromDimensionCalibration,
  pixelSizeFromScanGeometry,
} from "../.test-dist/lib/pixelSize.js";

test("formats metre calibration values like the metadata chip", () => {
  const size = isotropicPixelSizeFromMetres(1e-8, "um");
  assert.ok(size);
  assert.equal(formatPixelSize(size), "X 0.01 × Y 0.01 µm/px");
});

test("derives anisotropic pixel size from saved dimension calibration", () => {
  const size = pixelSizeFromDimensionCalibration({
    x_origin: 10,
    x_end: 110,
    y_origin: -20,
    y_end: 30,
    viewport_x_start: 64,
    viewport_x_end: 564,
    viewport_y_start: 100,
    viewport_y_end: 350,
    scale_unit: "um",
  });
  assert.deepEqual(size, {
    x: 0.2,
    y: 0.2,
    unit: "um",
    source: "dimensionCalibration",
  });
  assert.equal(formatPixelSize(size), "X 0.2 × Y 0.2 µm/px");
});

test("uses exact applied scan-geometry pixel size and rejects unavailable data", () => {
  const size = pixelSizeFromScanGeometry({ enabled: true, pixelSizeNm: [12.3456, 23.4567] });
  assert.deepEqual(size, {
    x: 12.3456,
    y: 23.4567,
    unit: "nm",
    source: "scanGeometry",
  });
  assert.equal(formatPixelSize(size), "X 12.35 × Y 23.46 nm/px");
  assert.equal(pixelSizeFromScanGeometry(null), null);
});

import {
  dacCodePitch,
  pixelSizeFromExtent,
  selectionPixelSize,
  selectionZoom,
} from "../.test-dist/lib/pixelSize.js";

const fov = { x_origin: 0, x_end: 100, y_origin: 0, y_end: 100, scanGeometry: null };

test("pixel pitch mirrors the FPGA UQ8.8 step on an inclusive DAC range", () => {
  assert.equal(dacCodePitch(0, 16383, 512), 32);
  assert.equal(dacCodePitch(16383, 0, 512), 32);
  assert.equal(dacCodePitch(0, 999, 300), 853 / 256);
  assert.equal(dacCodePitch(5, 5, 4096), 1 / 256);
});

test("a loaded image reports axis extent over native pixels", () => {
  const size = pixelSizeFromExtent(100, -100, 2048, 1024, "um", "loadedImage");
  assert.deepEqual(size, { x: 100 / 2048, y: 100 / 1024, unit: "um", source: "loadedImage" });
  assert.equal(pixelSizeFromExtent(100, 100, 0, 1024, "um", "loadedImage"), null);
});

test("selection pixel size defaults to the global one and shrinks with the ROI", () => {
  const global = pixelSizeFromExtent(100, 100, 1024, 1024, "um", "loadedImage");
  assert.equal(selectionPixelSize(global, null, fov, 1024), global);
  const half = selectionPixelSize(global, { x_start: 0, x_end: 50, y_start: 0, y_end: 50 }, fov, 1024);
  const quarter = selectionPixelSize(global, { x_start: 0, x_end: 25, y_start: 0, y_end: 25 }, fov, 1024);
  assert.ok(Math.abs(half.x - 50 / 1024) / (50 / 1024) < 0.005);
  assert.ok(Math.abs(quarter.y - 25 / 1024) / (25 / 1024) < 0.01);
  assert.ok(quarter.x < half.x && half.x < global.x);
  assert.equal(half.unit, "um");
});

test("zoom grows as the selected area shrinks and follows the longer side", () => {
  assert.equal(selectionZoom(null, fov), 1);
  const half = selectionZoom({ x_start: 0, x_end: 50, y_start: 0, y_end: 50 }, fov);
  const quarter = selectionZoom({ x_start: 0, x_end: 25, y_start: 0, y_end: 25 }, fov);
  assert.ok(half > 1.9 && half < 2.1);
  assert.ok(quarter > 3.9 && quarter < 4.1);
  const strip = selectionZoom({ x_start: 0, x_end: 100, y_start: 0, y_end: 25 }, fov);
  assert.ok(strip < 1.1);
});
