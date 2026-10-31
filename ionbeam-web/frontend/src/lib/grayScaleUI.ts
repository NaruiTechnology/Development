export type GrayScaleSourceKind = "raster" | "vector" | "loaded" | null;

export type ROIActionKind = "raster" | "vector";

/** Existing gray selections remain editable during a scan; other locks remain. */
export function grayControlAvailability(options: {
  locked: boolean;
  scanActive: boolean;
  hasTarget: boolean;
}) {
  return {
    targetDisabled: options.locked || (options.scanActive && !options.hasTarget),
    filterDisabled: options.locked,
  };
}

/** Explicit Select always confirms; automatic prompts need an actual edit. */
export function shouldConfirmVectorGrayRange(options: {
  enabled: boolean;
  explicit: boolean;
  edited: boolean;
  applied: boolean;
  range: readonly [number, number];
  appliedRange: readonly [number, number];
}): boolean {
  if (!options.enabled) return false;
  if (options.explicit === true) return true;
  return options.edited && (!options.applied ||
    options.range[0] !== options.appliedRange[0] || options.range[1] !== options.appliedRange[1]);
}

export type GrayScaleCopyKey =
  | "roi.grayScale.source.raster"
  | "roi.grayScale.source.vector"
  | "roi.grayScale.source.loaded"
  | "roi.grayScale.context.raster.production"
  | "roi.grayScale.context.raster.preview"
  | "roi.grayScale.context.vector";

export type GrayScaleTranslator = (key: GrayScaleCopyKey) => string;

export function resolveROIActionKind(
  kind: "roi" | ROIActionKind | "mag",
  lastScanKind: ROIActionKind
): ROIActionKind | null {
  if (kind === "raster" || kind === "vector") return kind;
  if (kind === "roi") return "vector";
  return null;
}

export function shouldShowROIActionControls(options: {
  kind: "roi" | ROIActionKind | "mag";
  hasPartialROI: boolean;
}): boolean {
  if (options.kind !== "roi") return options.kind !== "mag";
  return options.hasPartialROI;
}

/**
 * The unfiltered ROI action uses the vector canvas as its live scan surface.
 * It must become visible as soon as Action Run starts; waiting for the stream
 * to complete hides all scan progress behind the original ROI image.
 */
export function shouldShowROIActionVectorCanvas(options: {
  roiActionCanvasVisible: boolean;
  roiActionGrayFilterActive: boolean;
  scanImageDataUrl: string | null;
}): boolean {
  return (
    options.roiActionCanvasVisible &&
    !options.roiActionGrayFilterActive &&
    options.scanImageDataUrl === null
  );
}

export function shouldShowROIGrayScaleClear(options: {
  kind: "roi" | ROIActionKind | "mag";
  grayFilterActive: boolean;
}): boolean {
  return options.kind === "roi" && options.grayFilterActive;
}

export function resolveGrayScaleSourceKind(options: {
  showGraySpectrum: boolean;
  roiImageDataUrl: string | null;
  roiScanImageUrl: string | null;
  lastScanKind: "raster" | "vector";
}): GrayScaleSourceKind {
  if (!options.showGraySpectrum) return null;
  if (options.roiImageDataUrl) return "loaded";
  if (options.roiScanImageUrl) return options.lastScanKind;
  return null;
}

export function grayScaleSourceLabelForKind(
  sourceKind: GrayScaleSourceKind,
  t: GrayScaleTranslator
): string | null {
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

export function grayScaleScopeNoteForKind(
  sourceKind: GrayScaleSourceKind,
  isProduction: boolean,
  t: GrayScaleTranslator
): string | null {
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
