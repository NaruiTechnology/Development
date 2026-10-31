import type { ROIRequest, VectorPoint, VectorPointTuple } from "../types/api";
import { interpolateHfovM, type AppliedScanGeometry } from "./scanGeometry.js";

export interface ScanRegionFov {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  scanGeometry?: AppliedScanGeometry | null;
}

export interface ScanPixelBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Map a DAC ROI to the pixel rectangle it covers in a full-frame image. */
export function scanRegionPixelBounds(region: ROIRequest | null, edge: number): ScanPixelBounds {
  const size = Math.max(1, Math.trunc(edge));
  if (!region) return { x0: 0, x1: size, y0: 0, y1: size };

  const x0Dac = Math.min(region.x_start, region.x_end);
  const x1Dac = Math.max(region.x_start, region.x_end);
  const y0Dac = Math.min(region.y_start, region.y_end);
  const y1Dac = Math.max(region.y_start, region.y_end);
  const x0 = Math.max(0, Math.min(size - 1, Math.floor((x0Dac / 16383) * size)));
  const y0 = Math.max(0, Math.min(size - 1, Math.floor((y0Dac / 16383) * size)));
  const x1 = Math.max(x0 + 1, Math.min(size, Math.ceil((x1Dac / 16383) * size)));
  const y1 = Math.max(y0 + 1, Math.min(size, Math.ceil((y1Dac / 16383) * size)));
  return { x0, x1, y0, y1 };
}

/** Map one ROI-local scan sample to its destination in the full-frame buffer. */
export function mapScanPixelIndexToFrame(
  bounds: ScanPixelBounds,
  edge: number,
  x: number,
  y: number,
): number {
  const size = Math.max(1, Math.trunc(edge));
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  const targetX = bounds.x0 + Math.min(width - 1, Math.floor((x * width) / size));
  const targetY = bounds.y0 + Math.min(height - 1, Math.floor((y * height) / size));
  return targetY * size + targetX;
}

/** Per-axis lookup tables equivalent to `mapScanPixelIndexToFrame`, so the
 * streaming reducers map a sample with two array reads and one add instead of
 * a function call with clamping per sample: `ys[y] + xs[x]` is the frame index. */
export interface ScanPixelAxisMaps {
  xs: Int32Array;
  /** Already multiplied by the frame edge. */
  ys: Int32Array;
}

export function scanPixelAxisMaps(bounds: ScanPixelBounds, edge: number): ScanPixelAxisMaps {
  const size = Math.max(1, Math.trunc(edge));
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  const xs = new Int32Array(size);
  const ys = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    xs[i] = bounds.x0 + Math.min(width - 1, Math.floor((i * width) / size));
    ys[i] = (bounds.y0 + Math.min(height - 1, Math.floor((i * height) / size))) * size;
  }
  return { xs, ys };
}

/** Identity mapping (full frame). */
export function fullFrameAxisMaps(edge: number): ScanPixelAxisMaps {
  const size = Math.max(1, Math.trunc(edge));
  const xs = new Int32Array(size);
  const ys = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    xs[i] = i;
    ys[i] = i * size;
  }
  return { xs, ys };
}

/** Absolute zoom ceiling: the 14-bit DAC has 16384 codes and the lowest scan
 * resolution is 64 samples per axis, so 16384 / 64 = 256. The usable maximum
 * for a given resolution and ROI set is lower (see scanValidation.ts). */
export const MAX_SCAN_ZOOM = 16384 / 64;

export function clampScanZoom(value: unknown): number {
  const zoom = Number(value);
  return Number.isFinite(zoom) ? Math.max(1, Math.min(MAX_SCAN_ZOOM, Math.trunc(zoom))) : 1;
}

/** Convert a relative magnification into the physical FOV ratio measured by
 * the calibration table. Older configurations without a saved table retain
 * the ideal 1/magnification relationship. */
export function calibratedScanZoom(zoomValue: number, geometry?: AppliedScanGeometry | null): number {
  const zoom = clampScanZoom(zoomValue);
  const points = geometry?.magnificationCalibration;
  const mag = geometry?.magnification;
  if (!geometry?.enabled || !points || !mag || !Number.isFinite(mag)) return zoom;
  const baseFov = interpolateHfovM(points, mag);
  const zoomedFov = interpolateHfovM(points, mag * zoom);
  const ratio = baseFov && zoomedFov ? baseFov / zoomedFov : zoom;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : zoom;
}

/** Convert a requested physical ROI width (µm) to scan magnification. */
export function physicalZoomCoefficient(calibratedSpan: number, unit: string, requestedUm: number): number {
  const metresPerUnit: Record<string, number> = { m: 1, mm: 1e-3, um: 1e-6, "µm": 1e-6, "μm": 1e-6, nm: 1e-9 };
  const scale = metresPerUnit[unit];
  if (!Number.isFinite(calibratedSpan) || calibratedSpan <= 0 || !scale || !Number.isFinite(requestedUm) || requestedUm <= 0) return 1;
  return calibratedSpan * scale / (requestedUm * 1e-6);
}

/** Apply magnification around the centre of a scan area or selected ROI. */
export function zoomScanRegion(
  region: ROIRequest | null,
  zoomValue: number,
  fov: ScanRegionFov,
): ROIRequest | null {
  const zoom = calibratedScanZoom(zoomValue, fov.scanGeometry);
  if (!region && zoom === 1) return null;
  const base = region ?? {
    x_start: Math.min(fov.x_origin, fov.x_end),
    x_end: Math.max(fov.x_origin, fov.x_end),
    y_start: Math.min(fov.y_origin, fov.y_end),
    y_end: Math.max(fov.y_origin, fov.y_end),
  };
  const cx = (base.x_start + base.x_end) / 2;
  const cy = (base.y_start + base.y_end) / 2;
  const halfWidth = Math.abs(base.x_end - base.x_start) / (2 * zoom);
  const halfHeight = Math.abs(base.y_end - base.y_start) / (2 * zoom);
  return {
    x_start: cx - halfWidth,
    x_end: cx + halfWidth,
    y_start: cy - halfHeight,
    y_end: cy + halfHeight,
  };
}

/** One request region per selected area; without selections Zoom targets the full FOV. */
export function effectiveScanRegions(
  regions: ROIRequest[],
  zoom: number,
  fov: ScanRegionFov,
): Array<ROIRequest | null> {
  const source: Array<ROIRequest | null> = regions.length ? regions : [null];
  return source.map((region) => zoomScanRegion(region, zoom, fov));
}

/** Move a live custom path into new DAC bounds, retaining its point order,
 * dwell, blank flags and pass markers. The sample count stays fixed. */
export function zoomVectorPoints(
  points: Array<VectorPointTuple | VectorPoint>,
  from: ROIRequest | null,
  to: ROIRequest | null,
): Array<VectorPointTuple | VectorPoint> {
  return points.map((point) => zoomVectorPoint(point, from, to));
}

function zoomVectorPoint(
  point: VectorPointTuple | VectorPoint,
  from: ROIRequest | null,
  to: ROIRequest | null,
): VectorPointTuple | VectorPoint {
  const source = from ?? { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const target = to ?? { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
  const map = (value: number, a: number, b: number, c: number, d: number) => {
    const span = b - a;
    return Math.max(0, Math.min(16383, Math.round(c + ((value - a) / (Math.abs(span) > 1e-9 ? span : 1)) * (d - c))));
  };
  const x = Array.isArray(point) ? point[0] : point.x;
  const y = Array.isArray(point) ? point[1] : point.y;
  const nextX = map(x, source.x_start, source.x_end, target.x_start, target.x_end);
  const nextY = map(y, source.y_start, source.y_end, target.y_start, target.y_end);
  return Array.isArray(point)
    ? [nextX, nextY, ...point.slice(2)] as VectorPointTuple
    : { ...point, x: nextX, y: nextY };
}

/** Preserve the round-robin sample order of parallel custom paths. */
export function zoomInterleavedVectorPoints(
  points: Array<VectorPointTuple | VectorPoint>,
  groupLengths: number[],
  from: Array<ROIRequest | null>,
  to: Array<ROIRequest | null>,
): Array<VectorPointTuple | VectorPoint> {
  if (groupLengths.length !== from.length || from.length !== to.length ||
      groupLengths.reduce((sum, length) => sum + length, 0) !== points.length) {
    throw new Error("parallel custom point layout changed");
  }
  const result: Array<VectorPointTuple | VectorPoint> = [];
  let cursor = 0;
  for (let index = 0; index < Math.max(0, ...groupLengths); index += 1) {
    for (let group = 0; group < groupLengths.length; group += 1) {
      if (index >= groupLengths[group]) continue;
      result.push(zoomVectorPoint(points[cursor++], from[group], to[group]));
    }
  }
  return result;
}

