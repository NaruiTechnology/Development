import type { ROIRequest } from "../types/api";
import { worldSelectionToDacROI } from "./roiDac.js";
import { MAX_SCAN_ZOOM, effectiveScanRegions, type ScanRegionFov } from "./scanRegions.js";

export { MAX_SCAN_ZOOM };

/** The DAC has 14 bits: codes 0..16383. */
export const DAC_CODES = 16384;
/** Lowest scan resolution (samples per axis) and therefore the fewest DAC
 * codes a zoomed ROI may span: the hard zoom limit is DAC_CODES / 64 = 256 for
 * the full field and span / 64 for a smaller ROI. */
export const MIN_SCAN_RESOLUTION = 64;
/** The service builds a pass as an x * y DAC rectangle, each side <= 16384. */
export const HARDWARE_PASS_SAMPLE_LIMIT = DAC_CODES * DAC_CODES;
/** Heuristic: a single pass above this many samples is slow and memory heavy. */
export const HEAVY_PASS_SAMPLES = 1 << 24;
/** Heuristic: beyond this many ROIs the interleaved pass becomes unwieldy. */
export const MANY_REGIONS = 8;
/** Overlap (share of the smaller ROI) from which the overlap is called heavy. */
export const HEAVY_OVERLAP_FRACTION = 0.5;

export type ScanIssueCode =
  | "region_degenerate"
  | "zoom_exceeds_limit"
  | "oversampled"
  | "pass_exceeds_hardware"
  | "region_duplicate"
  | "region_overlap"
  | "pass_heavy"
  | "many_regions";

export interface ScanIssue {
  severity: "error" | "warning";
  code: ScanIssueCode;
  params: Record<string, number | string>;
}

export interface ScanPlan {
  /** DAC regions after zoom. `null` is the full field. */
  regions: Array<ROIRequest | null>;
  /** Samples per axis of each region. */
  resolution: number;
  /** True when a full-field background pass accompanies the regions. */
  background?: boolean;
  /** True when no ROI is selected and `regions` is the zoomed full field. */
  fullField?: boolean;
}

const FULL: ROIRequest = { x_start: 0, x_end: DAC_CODES - 1, y_start: 0, y_end: DAC_CODES - 1 };

interface Box { x0: number; x1: number; y0: number; y1: number }

function box(region: ROIRequest | null): Box {
  const r = region ?? FULL;
  return {
    x0: Math.min(r.x_start, r.x_end), x1: Math.max(r.x_start, r.x_end),
    y0: Math.min(r.y_start, r.y_end), y1: Math.max(r.y_start, r.y_end),
  };
}

/** Number of DAC codes a region spans on each axis (inclusive). */
export function regionSpanCodes(region: ROIRequest | null): { x: number; y: number } {
  const b = box(region);
  return { x: b.x1 - b.x0 + 1, y: b.y1 - b.y0 + 1 };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
  return w > 0 && h > 0 ? w * h : 0;
}

function area(b: Box): number {
  return (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
}

function toDac(regions: ROIRequest[], zoom: number, fov: ScanRegionFov): Array<ROIRequest | null> {
  return effectiveScanRegions(regions, zoom, fov).map((region) => region ? worldSelectionToDacROI(region, fov) : null);
}

function smallestSpan(regions: Array<ROIRequest | null>): number {
  let min = Infinity;
  for (const region of regions) {
    const span = regionSpanCodes(region);
    min = Math.min(min, span.x, span.y);
  }
  return Number.isFinite(min) ? min : DAC_CODES;
}

/**
 * Largest integer zoom for which every region (or the full field) still spans
 * at least MIN_SCAN_RESOLUTION (64) DAC codes per axis, the fewest distinct
 * positions the lowest scan resolution needs. Evaluated on the DAC regions the
 * scan would really use (including calibration and rounding), not on the
 * nominal ratio, and never above MAX_SCAN_ZOOM (16384 / 64 = 256).
 *
 * Scanning more samples than a zoomed ROI has DAC codes is allowed but wasteful
 * (see the `oversampled` warning), so the selected resolution does not lower
 * this limit.
 */
export function maxScanZoom(regions: ROIRequest[], fov: ScanRegionFov): number {
  const need = MIN_SCAN_RESOLUTION;
  const spanAt = (zoom: number): number => smallestSpan(toDac(regions, zoom, fov));
  if (spanAt(1) < need) return 1;
  let lo = 1;
  let hi = MAX_SCAN_ZOOM;
  // The span only shrinks as zoom grows, so bisect for the last passing zoom.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (spanAt(mid) >= need) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Validate the DAC regions a scan is about to use. Pure: no I/O, no state. */
export function validateScanPlan(plan: ScanPlan): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const resolution = Math.max(1, Math.trunc(plan.resolution));
  const need = MIN_SCAN_RESOLUTION;
  const hasRegions = plan.regions.length > 0;
  const regions = hasRegions ? plan.regions : [null];

  regions.forEach((region, index) => {
    const label = hasRegions && !plan.fullField ? index + 1 : 0; // 0 = the full field
    const span = regionSpanCodes(region);
    const smallest = Math.min(span.x, span.y);
    if (!Number.isFinite(smallest) || smallest < 1) {
      issues.push({ severity: "error", code: "region_degenerate", params: { region: label } });
    } else if (smallest < need) {
      issues.push({
        severity: "error", code: "zoom_exceeds_limit",
        params: { region: label, span: smallest, axis: span.x <= span.y ? "X" : "Y", need, resolution },
      });
    } else if (smallest < resolution) {
      // More samples than DAC codes: every code is visited several times. The
      // scan is valid but spends time and memory on positions it cannot resolve.
      const factor = resolution / smallest;
      issues.push({
        severity: "warning", code: "oversampled",
        params: {
          region: label, span: smallest, resolution,
          factor: Math.round(factor * 10) / 10,
          timeFactor: Math.round(factor * factor * 10) / 10,
        },
      });
    }
  });

  // Pass size: every region (plus a full-field background) is resolution^2 samples.
  const passRegions = regions.length + (plan.background && regions.some((r) => r !== null) ? 1 : 0);
  const samples = resolution * resolution * passRegions;
  if (samples > HARDWARE_PASS_SAMPLE_LIMIT) {
    issues.push({ severity: "error", code: "pass_exceeds_hardware", params: { samples, limit: HARDWARE_PASS_SAMPLE_LIMIT, regions: passRegions, resolution } });
  } else if (samples > HEAVY_PASS_SAMPLES) {
    issues.push({ severity: "warning", code: "pass_heavy", params: { samples, regions: passRegions, resolution } });
  }
  if (regions.length > MANY_REGIONS) {
    issues.push({ severity: "warning", code: "many_regions", params: { regions: regions.length, limit: MANY_REGIONS } });
  }

  // Overlap: overlapping ROIs re-acquire the same pixels and fight over them
  // in a composite image. Only real ROIs count, never the full-field background.
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      if (!regions[i] || !regions[j]) continue;
      const a = box(regions[i]);
      const b = box(regions[j]);
      const shared = overlapArea(a, b);
      if (!shared) continue;
      const fraction = shared / Math.min(area(a), area(b));
      const identical = a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
      issues.push({
        severity: "warning",
        code: identical ? "region_duplicate" : "region_overlap",
        params: { a: i + 1, b: j + 1, percent: Math.round(fraction * 100), heavy: fraction >= HEAVY_OVERLAP_FRACTION ? 1 : 0 },
      });
    }
  }
  return issues;
}

export interface ScanAssessment {
  /** Largest zoom allowed for the current resolution, ROIs and DAC capacity. */
  maxZoom: number;
  issues: ScanIssue[];
}

/**
 * Everything the Scan panel needs: the allowed maximum zoom and the issues for
 * `zoom`. A zoom limit issue carries the numbers needed for a technical
 * explanation (requested zoom, allowed maximum, ROI span before and after).
 */
export function assessScan(
  regions: ROIRequest[],
  zoom: number,
  fov: ScanRegionFov,
  resolution: number,
): ScanAssessment {
  const maxZoom = maxScanZoom(regions, fov);
  const base = toDac(regions, 1, fov);
  const issues = validateScanPlan({
    regions: toDac(regions, zoom, fov),
    resolution,
    background: regions.length > 0,
    fullField: regions.length === 0,
  }).map((issue) => {
    if (issue.code === "oversampled") return { ...issue, params: { ...issue.params, zoom } };
    if (issue.code !== "zoom_exceeds_limit") return issue;
    const region = Number(issue.params.region);
    const original = base[region > 0 ? region - 1 : 0];
    const baseSpan = Math.min(regionSpanCodes(original).x, regionSpanCodes(original).y);
    return { ...issue, params: { ...issue.params, zoom, max: maxZoom, baseSpan, dac: DAC_CODES } };
  });
  return { maxZoom, issues };
}

/** Same explanation for a zoom the operator typed but that was not applied. */
export function assessTypedZoom(
  regions: ROIRequest[],
  zoom: number,
  fov: ScanRegionFov,
  resolution: number,
): ScanIssue | null {
  const assessment = assessScan(regions, zoom, fov, resolution);
  const limit = assessment.issues.find((issue) => issue.code === "zoom_exceeds_limit");
  if (limit) return limit;
  if (zoom > assessment.maxZoom) {
    // Beyond the absolute ceiling the store clamps the zoom, so derive the
    // zoomed span from the smallest ROI directly.
    const base = toDac(regions, 1, fov);
    let index = 0;
    let baseSpan = Infinity;
    let axis = "X";
    base.forEach((region, i) => {
      const span = regionSpanCodes(region);
      const smallest = Math.min(span.x, span.y);
      if (smallest < baseSpan) { baseSpan = smallest; index = i; axis = span.x <= span.y ? "X" : "Y"; }
    });
    return {
      severity: "error", code: "zoom_exceeds_limit",
      params: {
        region: regions.length ? index + 1 : 0, span: Math.max(1, Math.floor(baseSpan / zoom)), axis,
        need: MIN_SCAN_RESOLUTION, resolution, zoom, max: assessment.maxZoom, baseSpan, dac: DAC_CODES,
      },
    };
  }
  return null;
}

export function hasScanErrors(issues: ScanIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
