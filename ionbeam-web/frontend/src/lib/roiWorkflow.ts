import type { ROIState } from "../store/scanSlice";
import type { VectorRequest } from "../types/api";
import { worldSelectionToDacROI } from "./roiDac.js";

/** Build the normal incremental ROI sweep used when no gray filter is active.
 * Omitting the browser bitmap is important: glasgow_service otherwise builds
 * the entire simulated bitmap frame before it can stream the first sample. */
export function unfilteredROIActionRequest(
  req: VectorRequest,
  roi: ROIState,
): VectorRequest {
  return {
    ...req,
    pattern: "default",
    points: null,
    roi: roi.selection ? worldSelectionToDacROI(roi.selection, roi) : null,
    simulation_bitmap: null,
    feedback_mode: "standard",
    gray_level_range: null,
    gray_level_skipped: null,
  };
}

/** Promote a completed partial scan without losing its physical position in the hardware FOV. */
export function completedROIImagePatch(
  roi: ROIState,
  imageDataUrl: string,
  imageName: string,
): Partial<ROIState> {
  return {
    imageName,
    imageDataUrl,
    imageKind: "lastScan",
    imageBounds: roi.selection ?? roi.imageBounds,
    scanImageDataUrl: null,
    roiScanResultUrl: imageDataUrl,
    selection: null,
  };
}
