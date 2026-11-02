import test from "node:test";
import assert from "node:assert/strict";
import { measuredFieldSpan } from "../.test-dist/lib/dimensionMeasurement.js";

test("texture lengths map to the whole field independently of their position or drag direction", () => {
  assert.equal(measuredFieldSpan(200, Math.abs(400 - 80)), 400);
  assert.equal(measuredFieldSpan(50, Math.abs(200 - 360)), 200);
  assert.equal(measuredFieldSpan(10, 640), 10);
});
test("zero length, clicks and invalid measurements cannot change calibration", () => {
  for (const [length, pixels] of [[0, 100], [-1, 100], [NaN, 100], [10, 0], [10, Infinity], [10, 641]]) {
    assert.throws(() => measuredFieldSpan(length, pixels));
  }
});
