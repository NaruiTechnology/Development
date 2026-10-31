import test from "node:test";
import assert from "node:assert/strict";
import { imageScale } from "../.test-dist/lib/imageScale.js";

test("scale has a true image fraction and readable physical units", () => {
  assert.deepEqual(imageScale({ x: 102400, y: 51200, unit: "nm" }), { fraction: 20000 / 102400, label: "20 µm" });
  assert.deepEqual(imageScale({ x: 0.004, y: 0.004, unit: "m" }), { fraction: 0.25, label: "1 mm" });
});
test("rotation uses the vertical calibration and zoom changes scale", () => {
  const extent = { x: 100, y: 20, unit: "um" };
  assert.deepEqual(imageScale(extent), { fraction: 0.2, label: "20 µm" });
  assert.deepEqual(imageScale(extent, true), { fraction: 0.25, label: "5 µm" });
  assert.deepEqual(imageScale({ ...extent, x: 50 }), { fraction: 0.2, label: "10 µm" });
});
test("unknown or invalid scales cannot produce a misleading bar", () => {
  for (const extent of [null, { x: 0 }, { x: -1 }, { x: Infinity }, { x: NaN }]) assert.equal(imageScale(extent), null);
  assert.deepEqual(imageScale({ x: 2048, y: 2048, unit: "px" }), { fraction: 500 / 2048, label: "500 px" });
});
