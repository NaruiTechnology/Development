import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDimensionCalibration,
  serializeDimensionCalibration,
} from "../.test-dist/lib/dimensionCalibrationPersistence.js";

const calibration = {
  x_origin: 12.5,
  x_end: 812.5,
  y_origin: -4,
  y_end: 396,
  viewport_x_start: 20,
  viewport_x_end: 620,
  viewport_y_start: 10,
  viewport_y_end: 630,
  scale_unit: "um",
};

test("DIMENTION CAL values survive a serialize/reload cycle", () => {
  assert.deepEqual(
    parseDimensionCalibration(serializeDimensionCalibration(calibration)),
    calibration
  );
});

test("invalid DIMENTION CAL storage is ignored", () => {
  assert.equal(parseDimensionCalibration("not-json"), null);
  assert.equal(parseDimensionCalibration(JSON.stringify({ ...calibration, x_end: 12.5 })), null);
  assert.equal(parseDimensionCalibration(JSON.stringify({ ...calibration, scale_unit: "" })), null);
  assert.equal(parseDimensionCalibration(JSON.stringify({ ...calibration, y_origin: null })), null);
});
