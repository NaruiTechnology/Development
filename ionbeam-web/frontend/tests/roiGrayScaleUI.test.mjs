import test from "node:test";
import assert from "node:assert/strict";

import {
  grayScaleScopeNoteForKind,
  grayScaleSourceLabelForKind,
  resolveROIActionKind,
  resolveGrayScaleSourceKind,
  shouldShowROIGrayScaleClear,
  shouldShowROIActionControls,
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

test("shows ROI gray-range Clear only after a range is confirmed", () => {
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "roi", hasConfirmedGrayRange: false }),
    false,
  );
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "roi", hasConfirmedGrayRange: true }),
    true,
  );
  assert.equal(
    shouldShowROIGrayScaleClear({ kind: "vector", hasConfirmedGrayRange: true }),
    false,
  );
});
