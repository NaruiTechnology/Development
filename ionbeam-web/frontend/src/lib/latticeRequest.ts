import { patternBounds, type PatternRoi } from "./processingPatterns.js";
import { DAC_FULL_SCALE, type ExposurePlan, type ScanAxis } from "./exposurePlan.js";
import type { LatticeRequest, LatticeShapeRequest } from "../types/api";

/** World -> DAC for one point. `linear` is true when the map is the plain FOV-to-0..16383 scaling
 * (no rectified scan geometry), so circles stay circles and rectangles stay axis-aligned. */
export interface DacMap { toDac(x: number, y: number): { x: number; y: number }; linear: boolean }

const CIRCLE_SEGMENTS = 96;

function ellipsePolygon(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
    const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

export function latticeShapeToDac(shape: PatternRoi, map: DacMap, frameWidthUM?: number): LatticeShapeRequest {
  const pt = (x: number, y: number): [number, number] => { const d = map.toDac(x, y); return [d.x, d.y]; };
  if ("points" in shape) return { kind: "polygon", points: shape.points.map(([x, y]) => pt(x, y)) };
  if ("cx" in shape) {
    const outer = "radius" in shape ? shape.radius : shape.r_outer, inner = "r_inner" in shape ? shape.r_inner : 0;
    const c = pt(shape.cx, shape.cy);
    if (map.linear) {
      const ex = pt(shape.cx + outer, shape.cy), ey = pt(shape.cx, shape.cy + outer);
      const ix = pt(shape.cx + inner, shape.cy), iy = pt(shape.cx, shape.cy + inner);
      return { kind: "ellipse", cx: c[0], cy: c[1], rx: Math.abs(ex[0] - c[0]), ry: Math.abs(ey[1] - c[1]),
        ...(inner > 0 ? { inner_rx: Math.abs(ix[0] - c[0]), inner_ry: Math.abs(iy[1] - c[1]) } : {}) };
    }
    if (inner > 0) throw new Error("A ring needs the plain FOV scan mapping; rectified scan geometry is not supported for rings yet.");
    return { kind: "polygon", points: ellipsePolygon(shape.cx, shape.cy, outer).map(([x, y]) => pt(x, y)) };
  }
  const a = pt(shape.x_start, shape.y_start), b = pt(shape.x_end, shape.y_end);
  if (frameWidthUM !== undefined && frameWidthUM > 0) {
    const x0 = Math.min(shape.x_start, shape.x_end), x1 = Math.max(shape.x_start, shape.x_end);
    const y0 = Math.min(shape.y_start, shape.y_end), y1 = Math.max(shape.y_start, shape.y_end);
    const w = Math.min(frameWidthUM, (x1 - x0) / 2), h = Math.min(frameWidthUM, (y1 - y0) / 2);
    const outer = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
    if (w >= (x1 - x0) / 2 || h >= (y1 - y0) / 2) return { kind: "polygon", points: outer };
    const inner = [pt(x0 + w, y0 + h), pt(x1 - w, y0 + h), pt(x1 - w, y1 - h), pt(x0 + w, y1 - h)];
    return { kind: "frame", outer, inner };
  }
  if (map.linear) return { kind: "rect", x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  return { kind: "polygon", points: [pt(shape.x_start, shape.y_start), pt(shape.x_end, shape.y_start), pt(shape.x_end, shape.y_end), pt(shape.x_start, shape.y_end)] };
}

/**
 * Request body for pattern "lattice". Pitch is converted um -> DAC codes per axis from the field size,
 * so the service needs no calibration. `plan` supplies spacing and passes; dwellTicks as in VectorRequest.dwell.
 */
export function buildLatticeRequest(shape: PatternRoi, plan: Pick<ExposurePlan, "spacingUM" | "passes">, dwellTicks: number,
  map: DacMap, field: { widthUM: number; heightUM: number }, axis: ScanAxis = "long", frameWidthUM?: number): LatticeRequest {
  if (!(field.widthUM > 0 && field.heightUM > 0)) throw new Error("Field size must be positive to convert spacing to DAC codes.");
  patternBounds(shape); // throws for malformed shapes early
  return {
    shape: latticeShapeToDac(shape, map, frameWidthUM),
    pitch_x: plan.spacingUM / (field.widthUM / DAC_FULL_SCALE),
    pitch_y: plan.spacingUM / (field.heightUM / DAC_FULL_SCALE),
    axis, dwell: dwellTicks, passes: plan.passes,
  };
}

/** Plain FOV mapping used when no rectified scan geometry is applied (mirrors worldSelectionToDacROI). */
export function linearDacMap(fov: { x_origin: number; x_end: number; y_origin: number; y_end: number }): DacMap {
  const x0 = Math.min(fov.x_origin, fov.x_end), x1 = Math.max(fov.x_origin, fov.x_end);
  const y0 = Math.min(fov.y_origin, fov.y_end), y1 = Math.max(fov.y_origin, fov.y_end);
  const clamp = (v: number) => Math.max(0, Math.min(DAC_FULL_SCALE, v));
  return { linear: true, toDac: (x, y) => ({
    x: clamp((x - x0) / Math.max(Number.EPSILON, x1 - x0) * DAC_FULL_SCALE),
    y: clamp((y - y0) / Math.max(Number.EPSILON, y1 - y0) * DAC_FULL_SCALE) }) };
}
