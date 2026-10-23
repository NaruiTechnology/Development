import test from "node:test";
import assert from "node:assert/strict";

import {
  canvasPointToWorld,
  imageWorldBounds,
  viewportBounds,
} from "../.test-dist/lib/roiGeometry.js";
import {
  completedROIImagePatch,
  unfilteredROIActionRequest,
} from "../.test-dist/lib/roiWorkflow.js";
import { worldSelectionToDacROI } from "../.test-dist/lib/roiDac.js";

function roi(overrides = {}) {
  return {
    x_origin: 0,
    x_end: 100,
    y_origin: 0,
    y_end: 100,
    viewport_x_start: 0,
    viewport_x_end: 640,
    viewport_y_start: 0,
    viewport_y_end: 640,
    calibration_viewport_x_start: 0,
    calibration_viewport_x_end: 640,
    calibration_viewport_y_start: 0,
    calibration_viewport_y_end: 640,
    imageDataUrl: "data:image/png;base64,current",
    imageBounds: null,
    selection: null,
    ...overrides,
  };
}

test("promotes a partial result while preserving its world bounds", () => {
  const selection = { x_start: 20, x_end: 60, y_start: 10, y_end: 50 };
  const patch = completedROIImagePatch(
    roi({ selection }),
    "data:image/png;base64,result",
    "Last scan",
  );

  assert.deepEqual(patch.imageBounds, selection);
  assert.equal(patch.selection, null);
  assert.equal(patch.imageDataUrl, "data:image/png;base64,result");
});

test("maps a nested selection against the prior result image bounds", () => {
  const current = roi({
    imageBounds: { x_start: 20, x_end: 60, y_start: 10, y_end: 50 },
  });
  const world = canvasPointToWorld(
    { x: 320, y: 320 },
    imageWorldBounds(current),
    viewportBounds(current),
  );

  assert.deepEqual(world, { x: 40, y: 30 });
  assert.deepEqual(
    { x_origin: current.x_origin, x_end: current.x_end },
    { x_origin: 0, x_end: 100 },
    "display rebasing must not alter the hardware FOV",
  );

  assert.deepEqual(
    worldSelectionToDacROI(
      { x_start: 30, x_end: 50, y_start: 20, y_end: 40 },
      current,
    ),
    { x_start: 4915, x_end: 8192, y_start: 3277, y_end: 6553 },
    "nested selections must remain absolute within the hardware DAC field",
  );
});

test("builds an unfiltered ROI action without a browser bitmap", () => {
  const current = roi({
    selection: { x_start: 20, x_end: 60, y_start: 10, y_end: 50 },
  });
  const request = unfilteredROIActionRequest({
    pattern: "custom",
    points: [[1, 2, 3]],
    simulation_bitmap: { width: 1, height: 1, pixels: [42] },
    feedback_mode: "adaptive_gray_feedback",
    gray_level_range: [10, 20],
    gray_level_skipped: true,
    vector_resolution: 1024,
    dwell: 16,
    latency_bytes: 8196,
    output_mode: "SixteenBit",
    adc_valid: true,
    beam_type: "Ion",
    external_control: true,
    cookie: 123,
    roi: null,
  }, current);

  assert.equal(request.pattern, "default");
  assert.equal(request.points, null);
  assert.deepEqual(request.roi, {
    x_start: 3277,
    x_end: 9830,
    y_start: 1638,
    y_end: 8192,
  });
  assert.equal(request.simulation_bitmap, null);
  assert.equal(request.feedback_mode, "standard");
  assert.equal(request.gray_level_range, null);
  assert.equal(request.gray_level_skipped, null);
});

