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
