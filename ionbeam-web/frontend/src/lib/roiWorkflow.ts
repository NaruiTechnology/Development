import type { ROIState } from "../store/scanSlice";

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
