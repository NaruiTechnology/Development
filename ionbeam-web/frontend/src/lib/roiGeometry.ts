import type { ROIState } from "../store/scanSlice";

export const ROI_CANVAS_EDGE = 640;
export const ROI_VIEWPORT_MIN_SPAN = 24;
export const ROI_AXIS_FONT = "12px ui-monospace, monospace";

type ViewportSource = Pick<
  ROIState,
  | "viewport_x_start"
  | "viewport_x_end"
  | "viewport_y_start"
  | "viewport_y_end"
  | "calibration_viewport_x_start"
  | "calibration_viewport_x_end"
  | "calibration_viewport_y_start"
  | "calibration_viewport_y_end"
>;

export interface ViewportBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

type ViewportMode = "confirmed" | "draft";

export function hasConfirmedCalibration(roi: {
  calibration_confirmed: boolean;
}): boolean {
  return roi.calibration_confirmed;
}

export function viewportBounds(roi: ViewportSource, mode: ViewportMode = "confirmed"): ViewportBounds {
  const x0 =
    mode === "draft" ? roi.calibration_viewport_x_start : roi.viewport_x_start;
  const x1 =
    mode === "draft" ? roi.calibration_viewport_x_end : roi.viewport_x_end;
  const y0 =
    mode === "draft" ? roi.calibration_viewport_y_start : roi.viewport_y_start;
  const y1 =
    mode === "draft" ? roi.calibration_viewport_y_end : roi.viewport_y_end;

  const left = clamp(Math.min(x0, x1), 0, ROI_CANVAS_EDGE);
  const right = clamp(Math.max(x0, x1), 0, ROI_CANVAS_EDGE);
  const top = clamp(Math.min(y0, y1), 0, ROI_CANVAS_EDGE);
  const bottom = clamp(Math.max(y0, y1), 0, ROI_CANVAS_EDGE);

  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function clampCanvasPointToViewport(
  point: { x: number; y: number },
  bounds: ViewportBounds
): { x: number; y: number } {
  return {
    x: clamp(point.x, bounds.left, bounds.right),
    y: clamp(point.y, bounds.top, bounds.bottom),
  };
}

export function canvasPointToWorld(
  point: { x: number; y: number },
  roi: Pick<ROIState, "x_origin" | "x_end" | "y_origin" | "y_end">,
  bounds: ViewportBounds
): { x: number; y: number } {
  const x = lerp(roi.x_origin, roi.x_end, normalize(point.x, bounds.left, bounds.right));
  const y = lerp(roi.y_origin, roi.y_end, normalize(point.y, bounds.top, bounds.bottom));
  return { x, y };
}

export function worldToCanvasX(
  value: number,
  roi: Pick<ROIState, "x_origin" | "x_end">,
  bounds: ViewportBounds
): number {
  return bounds.left + normalize(value, roi.x_origin, roi.x_end) * bounds.width;
}

export function worldToCanvasY(
  value: number,
  roi: Pick<ROIState, "y_origin" | "y_end">,
  bounds: ViewportBounds
): number {
  return bounds.top + normalize(value, roi.y_origin, roi.y_end) * bounds.height;
}

export function clampViewportCoordinate(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max);
}

function normalize(value: number, start: number, end: number): number {
  if (start === end) return 0;
  return clamp((value - start) / (end - start), 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
