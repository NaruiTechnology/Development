import test from "node:test";
import assert from "node:assert/strict";

import {
  grayScaleScopeNoteForKind,
  grayControlAvailability,
  shouldConfirmVectorGrayRange,
  grayScaleSourceLabelForKind,
  resolveROIActionKind,
  resolveGrayScaleSourceKind,
  shouldShowROIGrayScaleClear,
  shouldShowROIActionControls,
  shouldShowROIActionVectorCanvas,
} from "../.test-dist/lib/grayScaleUI.js";

const t = (key) => key;

test("prefers loaded-image gray-scale copy on the ROI page", () => {
  const sourceKind = resolveGrayScaleSourceKind({
    showGraySpectrum: true,
    roiImageDataUrl: "data:image/png;base64,abc",
    roiScanImageUrl: "/api/scan/last/figure?view=texture",
    lastScanKind: "vector",
  });

  assert.equal(sourceKind, "loaded");
  assert.equal(grayScaleSourceLabelForKind(sourceKind, t), null);
  assert.equal(grayScaleScopeNoteForKind(sourceKind, false, t), null);
});

test("falls back to the live scan source when no loaded image exists", () => {
  const sourceKind = resolveGrayScaleSourceKind({
    showGraySpectrum: true,
    roiImageDataUrl: null,
    roiScanImageUrl: "/api/scan/last/figure?view=texture",
    lastScanKind: "raster",
  });

  assert.equal(sourceKind, "raster");
  assert.equal(grayScaleSourceLabelForKind(sourceKind, t), "roi.grayScale.source.raster");
  assert.equal(grayScaleScopeNoteForKind(sourceKind, true, t), "roi.grayScale.context.raster.production");
});

test("returns no source copy when the spectrum is hidden", () => {
  const sourceKind = resolveGrayScaleSourceKind({
    showGraySpectrum: false,
    roiImageDataUrl: "data:image/png;base64,abc",
    roiScanImageUrl: "/api/scan/last/figure?view=texture",
    lastScanKind: "vector",
  });

  assert.equal(sourceKind, null);
  assert.equal(grayScaleSourceLabelForKind(sourceKind, t), null);
  assert.equal(grayScaleScopeNoteForKind(sourceKind, false, t), null);
});

test("shows ROI action controls for partial ROI selections", () => {
  assert.equal(
    shouldShowROIActionControls({
      kind: "roi",
      hasPartialROI: true,
    }),
    true
  );
  assert.equal(
    shouldShowROIActionControls({
      kind: "roi",
      hasPartialROI: false,
    }),
    false
  );
  assert.equal(
    shouldShowROIActionControls({
      kind: "vector",
      hasPartialROI: false,
    }),
    true
  );
});

test("uses vector style for ROI action runs", () => {
  assert.equal(resolveROIActionKind("roi", "raster"), "vector");
  assert.equal(resolveROIActionKind("roi", "vector"), "vector");
  assert.equal(resolveROIActionKind("vector", "raster"), "vector");
  assert.equal(resolveROIActionKind("mag", "raster"), null);
});

test("shows the unfiltered ROI vector canvas as soon as Action Run starts", () => {
  assert.equal(
    shouldShowROIActionVectorCanvas({
      roiActionCanvasVisible: true,
      roiActionGrayFilterActive: false,
      scanImageDataUrl: null,
    }),
    true,
  );
  assert.equal(
    shouldShowROIActionVectorCanvas({
      roiActionCanvasVisible: false,
      roiActionGrayFilterActive: false,
      scanImageDataUrl: null,
    }),
    false,
  );
  assert.equal(
    shouldShowROIActionVectorCanvas({
      roiActionCanvasVisible: true,
      roiActionGrayFilterActive: true,
      scanImageDataUrl: null,
    }),
    false,
  );
});

test("shows the ROI gray-range Clear action only for an active filter", () => {
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "roi", grayFilterActive: true }),
    true,
  );
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "roi", grayFilterActive: false }),
    false,
  );
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "vector", grayFilterActive: true }),
    false,
  );
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "raster", grayFilterActive: true }),
    false,
  );
});

test("selected gray controls remain available during scanning", () => {
  const running = { locked: false, scanActive: true, hasTarget: false };
  assert.deepEqual(grayControlAvailability(running), { targetDisabled: true, filterDisabled: false });
  assert.deepEqual(grayControlAvailability({ ...running, hasTarget: true }), { targetDisabled: false, filterDisabled: false });
  assert.deepEqual(grayControlAvailability({ ...running, scanActive: false }), { targetDisabled: false, filterDisabled: false });
});

test("gray controls retain authentication, stopping, ADC and action-run locks", () => {
  for (const scanActive of [false, true]) {
    for (const hasTarget of [false, true]) {
      assert.deepEqual(grayControlAvailability({ locked: true, scanActive, hasTarget }), { targetDisabled: true, filterDisabled: true });
    }
  }
});

test("Select confirms the current range without requiring another drag", () => {
  const range = { enabled: true, explicit: true, edited: false, applied: true, range: [192, 255], appliedRange: [192, 255] };
  assert.equal(shouldConfirmVectorGrayRange(range), true);
  assert.equal(shouldConfirmVectorGrayRange({ ...range, applied: false }), true);
  assert.equal(shouldConfirmVectorGrayRange({ ...range, enabled: false }), false);
});

test("automatic gray confirmation still requires a changed slider range", () => {
  const range = { enabled: true, explicit: false, edited: false, applied: true, range: [192, 255], appliedRange: [192, 255] };
  assert.equal(shouldConfirmVectorGrayRange(range), false);
  assert.equal(shouldConfirmVectorGrayRange({ ...range, edited: true }), false);
  assert.equal(shouldConfirmVectorGrayRange({ ...range, edited: true, range: [190, 255] }), true);
  assert.equal(shouldConfirmVectorGrayRange({ ...range, edited: true, applied: false }), true);
});
