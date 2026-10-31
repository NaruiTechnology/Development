import test from "node:test";
import assert from "node:assert/strict";

import {
  HARDWARE_PASS_SAMPLE_LIMIT,
  MAX_SCAN_ZOOM,
  assessScan,
  assessTypedZoom,
  hasScanErrors,
  maxScanZoom,
  validateScanPlan,
} from "../.test-dist/lib/scanValidation.js";

// World units == DAC codes (no calibrated geometry): the FOV spans 0..16383.
const fov = { x_origin: 0, x_end: 16383, y_origin: 0, y_end: 16383, scanGeometry: null };
const roi = (x0, x1, y0, y1) => ({ x_start: x0, x_end: x1, y_start: y0, y_end: y1 });

test("the absolute ceiling is the DAC capacity over the lowest resolution", () => {
  assert.equal(MAX_SCAN_ZOOM, 16384 / 64);
  assert.equal(MAX_SCAN_ZOOM, 256);
});

test("the hard zoom limit is 64 DAC codes per ROI axis, whatever the resolution", () => {
  assert.equal(maxScanZoom([], fov), 256);
  const big = roi(1000, 12999, 1000, 12999);   // 12000 codes
  const small = roi(2000, 5499, 2000, 5499);    // 3500 codes
  // Nominal span / 64, give or take the DAC rounding of the zoomed bounds.
  const nominal = (span) => Math.floor(span / 64);
  for (const [rois, span] of [[[big], 12000], [[small], 3500], [[big, small], 3500]]) {
    const max = maxScanZoom(rois, fov);
    assert.ok(Math.abs(max - nominal(span)) <= Math.ceil(nominal(span) * 0.05), `${span}: ${max}`);
    // The maximum is exact: valid at max, rejected one above.
    assert.equal(hasScanErrors(assessScan(rois, max, fov, 64).issues), false);
    assert.equal(hasScanErrors(assessScan(rois, max + 1, fov, 64).issues), true);
  }
  assert.equal(maxScanZoom([roi(0, 99, 0, 99)], fov), 1);
});

test("three ROIs like the operator's screenshot allow a zoom of at least 3", () => {
  // ~1,220 codes is the smallest ROI at 1024 samples: it used to cap the zoom at 1.
  const rois = [roi(5000, 6219, 5000, 6327), roi(10000, 13899, 3000, 6899), roi(1000, 14249, 12000, 16183)];
  const max = maxScanZoom(rois, fov);
  assert.ok(max >= 3, `max zoom ${max}`);
  assert.ok(max >= 18 && max <= 20, `max zoom ${max}`);
  const at3 = assessScan(rois, 3, fov, 1024);
  assert.equal(hasScanErrors(at3.issues), false);
});

test("oversampling is a warning with its cost, not an error", () => {
  const small = roi(2000, 5499, 2000, 5499);
  const ok = assessScan([small], 3, fov, 1024);          // 1166 codes >= 1024 samples
  assert.equal(ok.issues.some((i) => i.code === "oversampled"), false);
  const warn = assessScan([small], 4, fov, 1024);        // 875 codes < 1024 samples
  assert.equal(hasScanErrors(warn.issues), false);
  const issue = warn.issues.find((i) => i.code === "oversampled");
  assert.ok(issue);
  assert.equal(issue.params.region, 1);
  assert.equal(issue.params.zoom, 4);
  assert.equal(issue.params.span, 876);
  assert.equal(issue.params.factor, 1.2);
  assert.equal(issue.params.timeFactor, 1.4);
  // A lower resolution removes the warning.
  assert.equal(assessScan([small], 4, fov, 512).issues.some((i) => i.code === "oversampled"), false);
});

test("a zoom beyond the hard limit is rejected with the numbers", () => {
  const small = roi(2000, 5499, 2000, 5499);
  const over = assessScan([small], 60, fov, 1024);
  assert.equal(over.maxZoom, 56);
  const issue = over.issues.find((i) => i.code === "zoom_exceeds_limit");
  assert.ok(issue);
  assert.equal(issue.params.region, 1);
  assert.equal(issue.params.zoom, 60);
  assert.equal(issue.params.max, 56);
  assert.equal(issue.params.baseSpan, 3500);
  assert.equal(issue.params.need, 64);
  assert.ok(issue.params.span < 64);
  assert.ok(hasScanErrors(over.issues));
});

test("full-field issues are labelled region 0", () => {
  const warn = assessScan([], 17, fov, 1024);   // 964 codes < 1024 samples
  assert.equal(warn.issues.find((i) => i.code === "oversampled").params.region, 0);
  const over = assessTypedZoom([], 300, fov, 1024);
  assert.equal(over.params.region, 0);
});

test("a typed zoom above the absolute ceiling still gets an explanation", () => {
  const issue = assessTypedZoom([], 5000, fov, 64);
  assert.ok(issue);
  assert.equal(issue.code, "zoom_exceeds_limit");
  assert.equal(issue.params.max, 256);
  assert.equal(issue.params.zoom, 5000);
  assert.equal(assessTypedZoom([], 256, fov, 1024), null);
  assert.ok(assessTypedZoom([], 257, fov, 1024));
});

test("overlap and identical ROIs warn but do not block", () => {
  const overlap = validateScanPlan({ regions: [roi(0, 4999, 0, 4999), roi(2500, 7499, 2500, 7499)], resolution: 256 });
  const a = overlap.find((i) => i.code === "region_overlap");
  assert.ok(a);
  assert.equal(a.severity, "warning");
  assert.equal(a.params.percent, 25);
  assert.equal(hasScanErrors(overlap), false);
  const identical = validateScanPlan({ regions: [roi(0, 4999, 0, 4999), roi(0, 4999, 0, 4999)], resolution: 256 });
  assert.ok(identical.some((i) => i.code === "region_duplicate"));
  const disjoint = validateScanPlan({ regions: [roi(0, 999, 0, 999), roi(5000, 5999, 5000, 5999)], resolution: 256 });
  assert.equal(disjoint.length, 0);
});

test("the full-field background never counts as an overlap", () => {
  const issues = validateScanPlan({ regions: [null, roi(0, 4999, 0, 4999)], resolution: 256 });
  assert.equal(issues.some((i) => i.code === "region_overlap"), false);
});

test("pass size: heavy warns, over the hardware limit blocks", () => {
  const heavy = validateScanPlan({ regions: [roi(0, 3999, 0, 3999), roi(4000, 7999, 4000, 7999), roi(8000, 11999, 8000, 11999), roi(12000, 15999, 12000, 15999)], resolution: 2048, background: true });
  assert.ok(heavy.some((i) => i.code === "pass_heavy"));
  assert.equal(hasScanErrors(heavy), false);
  assert.equal(HARDWARE_PASS_SAMPLE_LIMIT, 16384 * 16384);
  const many = Array.from({ length: 70 }, () => roi(0, 16383, 0, 16383));
  assert.ok(validateScanPlan({ regions: many, resolution: 2048 }).some((i) => i.code === "pass_exceeds_hardware"));
});

test("many ROIs warn", () => {
  const regions = Array.from({ length: 9 }, (_, i) => roi(i * 1000, i * 1000 + 900, 0, 900));
  assert.ok(validateScanPlan({ regions, resolution: 64 }).some((i) => i.code === "many_regions"));
});

test("a degenerate ROI is an error", () => {
  const issues = validateScanPlan({ regions: [{ x_start: 5, x_end: 5, y_start: 0, y_end: 0 }], resolution: 64 });
  assert.ok(hasScanErrors(issues));
});
