/** Promote a completed partial scan without losing its physical position in the hardware FOV. */
export function completedROIImagePatch(roi, imageDataUrl, imageName) {
    return {
        imageName,
        imageDataUrl,
        imageKind: "lastScan",
        imageBounds: roi.selection ?? roi.imageBounds,
        scanImageDataUrl: null,
        selection: null,
    };
}
