export function resolveROIActionKind(kind, lastScanKind) {
    if (kind === "raster" || kind === "vector")
        return kind;
    if (kind === "roi")
        return "vector";
    return null;
}
export function shouldShowROIActionControls(options) {
    if (options.kind !== "roi")
        return options.kind !== "mag";
    return options.hasPartialROI;
}
export function shouldShowROIGrayScaleClear(options) {
    return options.kind === "roi" && options.hasConfirmedGrayRange;
}
export function resolveGrayScaleSourceKind(options) {
    if (!options.showGraySpectrum)
        return null;
    if (options.roiImageDataUrl)
        return "loaded";
    if (options.roiScanImageUrl)
        return options.lastScanKind;
    return null;
}
export function grayScaleSourceLabelForKind(sourceKind, t) {
    switch (sourceKind) {
        case "raster":
            return t("roi.grayScale.source.raster");
        case "vector":
            return t("roi.grayScale.source.vector");
        case "loaded":
            return null;
        default:
            return null;
    }
}
export function grayScaleScopeNoteForKind(sourceKind, isProduction, t) {
    switch (sourceKind) {
        case "raster":
            return isProduction
                ? t("roi.grayScale.context.raster.production")
                : t("roi.grayScale.context.raster.preview");
        case "vector":
            return t("roi.grayScale.context.vector");
        case "loaded":
            return null;
        default:
            return null;
    }
}
