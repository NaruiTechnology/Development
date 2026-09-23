import type { ROIRequest } from "../types/api";
import { worldRectToDacROI, type AppliedScanGeometry } from "./scanGeometry.js";

const DAC_MAX = 16383;

/**
 * Map a world-unit selection to absolute DAC coordinates within the hardware FOV.
 *
 * With an applied scan geometry (CONFIGURATION > Admin > Calibration > Scan geometry) the selection is taken as
 * physical world coordinates (µm) and mapped through the rectified world -> DAC transform. Without one the original
 * linear mapping applies: the FOV bounds (x_origin..x_end, y_origin..y_end) span the full DAC range 0..16383.
 */
export function worldSelectionToDacROI(
  selection: ROIRequest,
  fov: { x_origin: number; x_end: number; y_origin: number; y_end: number; scanGeometry?: AppliedScanGeometry | null },
): ROIRequest {
  if (fov.scanGeometry?.enabled) {
    return worldRectToDacROI(fov.scanGeometry.inverse, selection);
  }
  const fovX0 = Math.min(fov.x_origin, fov.x_end);
  const fovX1 = Math.max(fov.x_origin, fov.x_end);
  const fovY0 = Math.min(fov.y_origin, fov.y_end);
  const fovY1 = Math.max(fov.y_origin, fov.y_end);
  const sx0 = clampToRange(Math.min(selection.x_start, selection.x_end), fovX0, fovX1);
  const sx1 = clampToRange(Math.max(selection.x_start, selection.x_end), fovX0, fovX1);
  const sy0 = clampToRange(Math.min(selection.y_start, selection.y_end), fovY0, fovY1);
  const sy1 = clampToRange(Math.max(selection.y_start, selection.y_end), fovY0, fovY1);
  const spanX = Math.max(Number.EPSILON, fovX1 - fovX0);
  const spanY = Math.max(Number.EPSILON, fovY1 - fovY0);
  const toDac = (value: number, origin: number, span: number): number =>
    Math.max(0, Math.min(DAC_MAX, Math.round(((value - origin) / span) * DAC_MAX)));
  const dx0 = toDac(sx0, fovX0, spanX);
  const dx1 = toDac(sx1, fovX0, spanX);
  const dy0 = toDac(sy0, fovY0, spanY);
  const dy1 = toDac(sy1, fovY0, spanY);

  return {
    x_start: dx0,
    x_end: Math.min(DAC_MAX, Math.max(dx0 + 1, dx1)),
    y_start: dy0,
    y_end: Math.min(DAC_MAX, Math.max(dy0 + 1, dy1)),
  };
}

function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
