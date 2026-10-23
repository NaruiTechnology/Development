import type { RootState } from "./index";
import {
  pixelSizeFromDimensionCalibration,
  pixelSizeFromScanGeometry,
  type PixelSize,
} from "../lib/pixelSize";

/**
 * The single application-wide calibrated pixel size. Applied scan geometry
 * is authoritative; a saved manual Dimension Cal mapping is the fallback.
 */
export function selectGlobalPixelSize(state: RootState): PixelSize | null {
  return (
    pixelSizeFromScanGeometry(state.scan.roi.scanGeometry) ??
    (state.dimensionCalibration.persisted
      ? pixelSizeFromDimensionCalibration(state.dimensionCalibration.values)
      : null)
  );
}
