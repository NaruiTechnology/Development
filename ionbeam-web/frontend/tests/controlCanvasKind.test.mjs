import test from "node:test";
import assert from "node:assert/strict";
import { controlCanvasKind } from "../.test-dist/lib/controlCanvasKind.js";
import { createServer } from "vite";

test("Scan always owns its raster/vector canvas after Processing or Dimension Cal", () => {
  for (const scan of ["raster", "vector"]) {
    for (const calibration of ["dimension", "mag"]) {
      assert.equal(controlCanvasKind("processing", scan, calibration), "roi");
      assert.equal(controlCanvasKind("calibrate", scan, calibration), calibration === "dimension" ? "roi" : "mag");
      assert.equal(controlCanvasKind("scan", scan, calibration), scan);
    }
  }
});

test("late saved calibration updates preserve Scan's canvas without activating editor handles", async () => {
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  try {
  const { default: reducer, applyPersistedDimensionCalibration, updateROI } = await vite.ssrLoadModule("/src/store/scanSlice.ts");
  let state = reducer(undefined, { type: "init" });
  state = reducer(state, updateROI({ calibration_enabled: false }));
  const values = { x_origin: 0, x_end: 799.1, y_origin: 0, y_end: 991.9,
    viewport_x_start: 64, viewport_x_end: 558, viewport_y_start: 196, viewport_y_end: 451, scale_unit: "um" };
  state = reducer(state, applyPersistedDimensionCalibration({ ...values, activate: false }));
  assert.equal(state.roi.calibration_enabled, false);
  assert.equal(state.roi.x_end, 799.1);
  assert.equal(state.roi.y_end, 991.9);
  state = reducer(state, applyPersistedDimensionCalibration(values));
  assert.equal(state.roi.calibration_enabled, true, "explicit Dimension Cal entry still enables editing");
  } finally {
    await vite.close();
  }
});
