import type { ROIState } from "../store/scanSlice";
import type { RasterRequest, VectorRequest } from "../types/api";
import { worldSelectionToDacROI } from "./roiDac.js";

/** Apply the resolution and dwell shown in the ROI Raster controls to the
 * vector-style request used to execute an unfiltered ROI action. */
export function roiRasterExecutionRequest(
  req: VectorRequest,
  settings: Pick<RasterRequest, "resolution" | "dwell">,
): VectorRequest {
  return {
    ...req,
    vector_resolution: settings.resolution,
    dwell: settings.dwell,
  };
}

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
  const completedBounds = roi.selection ?? roi.imageBounds;
  return {
    imageName,
    imageDataUrl,
    imageKind: "lastScan",
    imageBounds: completedBounds,
    scanImageDataUrl: null,
    roiScanResultUrl: imageDataUrl,
    // Keep the completed region selected. Clearing it resets hasPartialROI,
    // which unmounts the ROI action controls and makes the active ROI tab look
    // as if it was reset after every successful scan. The promoted image uses
    // the same world bounds, so this selection also remains valid for another
    // action over the completed area.
    selection: completedBounds,
  };
}
