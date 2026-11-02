import test from "node:test";
import assert from "node:assert/strict";
import { fullCanvasImageExtent, imageScale } from "../.test-dist/lib/imageScale.js";

test("scale has a true image fraction and readable physical units", () => {
  assert.deepEqual(imageScale({ x: 102400, y: 51200, unit: "nm" }), { fraction: 20000 / 102400, label: "20.0 µm" });
  assert.deepEqual(imageScale({ x: 0.004, y: 0.004, unit: "m" }), { fraction: 0.25, label: "1.0 mm" });
});
test("rotation uses the vertical calibration and field span changes scale", () => {
  const extent = { x: 100, y: 20, unit: "um" };
  assert.deepEqual(imageScale(extent), { fraction: 0.2, label: "20.0 µm" });
  assert.deepEqual(imageScale(extent, true), { fraction: 0.25, label: "5.0 µm" });
  assert.deepEqual(imageScale({ ...extent, x: 50 }), { fraction: 0.2, label: "10.0 µm" });
});
test("unknown or invalid scales cannot produce a misleading bar", () => {
  for (const extent of [null, { x: 0 }, { x: -1 }, { x: Infinity }, { x: NaN }]) assert.equal(imageScale(extent), null);
  assert.deepEqual(imageScale({ x: 2048, y: 2048, unit: "px" }), { fraction: 500 / 2048, label: "500.0 px" });
});

test("labels adapt to changes in the calibrated field span", () => {
  for (const width of [20, 40, 64.8, 90, 120, 160, 263]) {
    for (const [from, to] of [[3, 7], [2, 4], [5, 10]]) {
      const a = imageScale({ x: width / from, y: width / from, unit: "µm" });
      const b = imageScale({ x: width / to, y: width / to, unit: "µm" });
      assert.notEqual(a.label, b.label, `${width} µm ROI, zoom ${from}->${to}`);
      assert.ok(a.fraction <= 0.25 && b.fraction <= 0.25);
      assert.match(a.label, /^\d+\.\d \S+$/);
    }
  }
  assert.equal(imageScale({ x: 12.5, y: 12.5, unit: "µm" }).label, "3.0 µm");
  assert.equal(imageScale({ x: 6, y: 6, unit: "µm" }).label, "1.5 µm");
  assert.equal(imageScale({ x: 0.5, y: 0.5, unit: "µm" }).label, "100.0 nm");
});

test("ROI additions and Zoom selections preserve both scale fraction and label", () => {
  const field = { x_origin: 0, x_end: 1200, y_origin: 0, y_end: 900, scale_unit: "µm" };
  const geometry = { enabled: true, pixels: [512, 384] };
  const calibrated = { source: "scanGeometry", x: 2000, y: 2000, unit: "nm" };
  for (const [base, pixelSize] of [[field, null], [{ ...field, scanGeometry: geometry }, calibrated]]) {
    for (const rotated of [false, true]) {
      const expected = imageScale(fullCanvasImageExtent(base, pixelSize), rotated);
      for (const scan_zoom of [1, 2, 4, 7, 10]) {
        for (const scan_regions of [[], [{ x_start: 10, x_end: 100 }], [{ x_start: 10, x_end: 100 }, { x_start: 200, x_end: 300 }]]) {
          const changed = { ...base, scan_zoom, scan_regions };
          assert.deepEqual(imageScale(fullCanvasImageExtent(changed, pixelSize), rotated), expected);
        }
      }
    }
  }
  assert.deepEqual(fullCanvasImageExtent(field), { x: 1200, y: 900, unit: "µm" });
  assert.deepEqual(fullCanvasImageExtent({ ...field, scanGeometry: geometry }, calibrated), { x: 1024000, y: 768000, unit: "nm" });
});

test("invalid fields have no scale and invalid geometry falls back to field span", () => {
  const field = { x_origin: 0, x_end: 120, y_origin: 0, y_end: 90, scale_unit: "µm" };
  assert.equal(fullCanvasImageExtent({ ...field, x_end: 0 }), null);
  assert.deepEqual(fullCanvasImageExtent({ ...field, scanGeometry: { enabled: true, pixels: [0, 0] } },
    { source: "scanGeometry", x: 1, y: 1, unit: "nm" }), fullCanvasImageExtent(field));
});
