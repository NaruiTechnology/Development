import test from "node:test";
import assert from "node:assert/strict";

import {
  MAG_CURVE_TOLERANCE,
  checkAgainstCurve,
  computeHfovM,
  hfovFromPixelSizeM,
  pixelSizeM,
  replacesPoint,
} from "../.test-dist/lib/magCalibrationMath.js";

test("pixel size is length per pixel and HFOV is pixel size times image width", () => {
  assert.equal(pixelSizeM(1e-6, 100), 1e-8);
  assert.ok(Math.abs(hfovFromPixelSizeM(1e-8, 1024) - 1.024e-5) < 1e-18);
  // Same formula the store used before the refactor: L * (res / px).
  assert.ok(Math.abs(computeHfovM(1e-6, 100, 1024) - 1e-6 * (1024 / 100)) < 1e-18);
});

test("unusable inputs give 0 instead of NaN or Infinity", () => {
  for (const [l, p, r] of [[0, 100, 1024], [1e-6, 0, 1024], [1e-6, 100, 0], [NaN, 100, 1024], [1e-6, Infinity, 1024]]) {
    assert.equal(computeHfovM(l, p, r), 0);
  }
});

test("a point on the 1/mag curve is not flagged", () => {
  const points = { "1000": 1e-4, "10000": 1e-5 };
  const check = checkAgainstCurve(points, 5000, 2e-5);
  assert.ok(check);
  assert.ok(check.expectedM > 1e-5 && check.expectedM < 1e-4);
  assert.equal(checkAgainstCurve(points, 2000, 5e-5).flagged, false);
});

test("a mistyped point is flagged with its deviation", () => {
  const points = { "1000": 1e-4, "10000": 1e-5 };
  const check = checkAgainstCurve(points, 2000, 5e-4);
  assert.ok(check.flagged);
  assert.ok(check.deviation > 1);
});

test("replacing an existing magnification compares with the other points only", () => {
  const points = { "1000": 1e-4, "2000": 5e-5 };
  // Re-measuring 2000x: its own old value must not vouch for the new one.
  const check = checkAgainstCurve(points, 2000, 5.1e-5);
  assert.ok(Math.abs(check.expectedM - 5e-5) < 1e-12);
  assert.equal(check.flagged, false);
  assert.equal(replacesPoint(points, 2000), true);
  assert.equal(replacesPoint(points, 3000), false);
});

test("nothing to compare with when the curve is empty or the input is bad", () => {
  assert.equal(checkAgainstCurve({}, 1000, 1e-4), null);
  assert.equal(checkAgainstCurve({ "1000": 1e-4 }, 1000, 1e-4), null);
  assert.equal(checkAgainstCurve({ "1000": 1e-4 }, 2000, 0), null);
  assert.equal(MAG_CURVE_TOLERANCE, 0.05);
});
