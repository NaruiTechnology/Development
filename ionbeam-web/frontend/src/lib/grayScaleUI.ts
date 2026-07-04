import type { GrayScaleSelection } from "./grayScaleSelection";

export type GrayScaleSourceKind = "raster" | "vector" | "loaded" | null;

export type ROIActionKind = "raster" | "vector";

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
  showGraySpectrum: boolean;
  committedGrayScaleSelection: GrayScaleSelection;
}): boolean {
  if (options.kind !== "roi") return options.kind !== "mag";
  return options.showGraySpectrum && options.committedGrayScaleSelection !== null;
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
