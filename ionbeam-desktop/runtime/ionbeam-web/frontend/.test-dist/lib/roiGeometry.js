export const ROI_CANVAS_EDGE = 640;
export const ROI_VIEWPORT_MIN_SPAN = 24;
export const ROI_AXIS_FONT = "12px ui-monospace, monospace";
/** Coordinate space occupied by the displayed bitmap, independent of the hardware FOV. */
export function imageWorldBounds(roi) {
    const bounds = roi.imageDataUrl ? roi.imageBounds : null;
    return bounds
        ? {
            x_origin: bounds.x_start,
            x_end: bounds.x_end,
            y_origin: bounds.y_start,
            y_end: bounds.y_end,
        }
        : roi;
}
export function hasConfirmedCalibration(roi) {
    return roi.calibration_confirmed;
}
export function viewportBounds(roi, mode = "confirmed") {
    const x0 = mode === "draft" ? roi.calibration_viewport_x_start : roi.viewport_x_start;
    const x1 = mode === "draft" ? roi.calibration_viewport_x_end : roi.viewport_x_end;
    const y0 = mode === "draft" ? roi.calibration_viewport_y_start : roi.viewport_y_start;
    const y1 = mode === "draft" ? roi.calibration_viewport_y_end : roi.viewport_y_end;
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
export function clampCanvasPointToViewport(point, bounds) {
    return {
        x: clamp(point.x, bounds.left, bounds.right),
        y: clamp(point.y, bounds.top, bounds.bottom),
    };
}
export function canvasPointToWorld(point, roi, bounds) {
    const x = lerp(roi.x_origin, roi.x_end, normalize(point.x, bounds.left, bounds.right));
    const y = lerp(roi.y_origin, roi.y_end, normalize(point.y, bounds.top, bounds.bottom));
    return { x, y };
}
export function worldToCanvasX(value, roi, bounds) {
    return bounds.left + normalize(value, roi.x_origin, roi.x_end) * bounds.width;
}
export function worldToCanvasY(value, roi, bounds) {
    return bounds.top + normalize(value, roi.y_origin, roi.y_end) * bounds.height;
}
export function clampViewportCoordinate(value, min, max) {
    return clamp(Math.round(value), min, max);
}
function normalize(value, start, end) {
    if (start === end)
        return 0;
    return clamp((value - start) / (end - start), 0, 1);
}
function lerp(a, b, t) {
    return a + (b - a) * t;
}
function clamp(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
