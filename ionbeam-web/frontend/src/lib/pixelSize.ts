import type { DimensionCalibrationValues } from "./dimensionCalibrationPersistence";
import type { ROIRequest } from "../types/api";
import { DAC_MAX, worldSelectionToDacROI } from "./roiDac.js";
import { DAC_CODES, type AppliedScanGeometry } from "./scanGeometry.js";

/** Physical size represented by one calibrated image pixel. */
export interface PixelSize {
  x: number;
  y: number;
  unit: string;
  source: "scanGeometry" | "dimensionCalibration" | "loadedImage" | "scanRegion";
}

function validSize(x: number, y: number): boolean {
  return Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0;
}

export function pixelSizeFromScanGeometry(
  geometry: AppliedScanGeometry | null | undefined,
): PixelSize | null {
  if (!geometry?.enabled) return null;
  const [x, y] = geometry.pixelSizeNm;
  return validSize(x, y) ? { x, y, unit: "nm", source: "scanGeometry" } : null;
}

export function pixelSizeFromDimensionCalibration(
  calibration: DimensionCalibrationValues,
): PixelSize | null {
  const pixelsX = Math.abs(calibration.viewport_x_end - calibration.viewport_x_start);
  const pixelsY = Math.abs(calibration.viewport_y_end - calibration.viewport_y_start);
  const x = Math.abs(calibration.x_end - calibration.x_origin) / pixelsX;
  const y = Math.abs(calibration.y_end - calibration.y_origin) / pixelsY;
  return validSize(x, y)
    ? { x, y, unit: calibration.scale_unit, source: "dimensionCalibration" }
    : null;
}

/**
 * Pixel size when no calibration or scan geometry exists: a world extent
 * (e.g. the loaded image's axes, or the scanned region) spread over a pixel
 * count (the image's native size, or the scan resolution).
 */
export function pixelSizeFromExtent(
  spanX: number,
  spanY: number,
  pixelsX: number,
  pixelsY: number,
  unit: string,
  source: "loadedImage" | "scanRegion",
): PixelSize | null {
  const x = Math.abs(spanX) / pixelsX;
  const y = Math.abs(spanY) / pixelsY;
  return validSize(x, y) ? { x, y, unit, source } : null;
}

/** Convert an isotropic size in metres to the unit used by the metadata chip. */
export function isotropicPixelSizeFromMetres(
  valueM: number,
  unit: string,
): PixelSize | null {
  const metresPerUnit: Record<string, number> = {
    m: 1,
    mm: 1e-3,
    um: 1e-6,
    "µm": 1e-6,
    "μm": 1e-6,
    nm: 1e-9,
  };
  const scale = metresPerUnit[unit];
  if (!scale) return null;
  const value = valueM / scale;
  return validSize(value, value)
    ? { x: value, y: value, unit, source: "dimensionCalibration" }
    : null;
}

function displayUnit(unit: string): string {
  return unit === "um" || unit === "μm" ? "µm" : unit;
}

function displayValue(value: number): string {
  return Number(value.toPrecision(4)).toString();
}

/** Compact anisotropic readout used beside X/Y coordinate messages. */
export function formatPixelSize(size: PixelSize): string {
  return `X ${displayValue(size.x)} × Y ${displayValue(size.y)} ${displayUnit(size.unit)}/px`;
}

/** Field of view the ROI selection is expressed in (the ROI editor's axes). */
export interface SelectionFov {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  scanGeometry?: AppliedScanGeometry | null;
}

/**
 * DAC codes between neighbouring pixels of a scan over `startCode..endCode`
 * (inclusive) in `count` pixels. Mirrors glasgow_service roi_scaling.dac_step:
 * the FPGA steps in UQ8.8, so the pitch is truncated to 1/256 of a code.
 */
export function dacCodePitch(startCode: number, endCode: number, count: number): number {
  const lo = Math.min(startCode, endCode);
  const hi = Math.max(startCode, endCode);
  const span = Math.max(1, hi - lo + 1);
  return Math.max(1, Math.trunc((span / count) * 256)) / 256;
}

/**
 * Pixel size of a partial-ROI scan, derived from the same DAC range and pitch
 * the scan itself is sent with, so the readout matches the scanned data.
 * Falls back to the global pixel size when there is no selection (or the inputs
 * cannot give a valid size), so callers can use it wherever the global one was used.
 *
 * Size per DAC code comes from the global pixel size when scan geometry is
 * applied (global size = size per code x DAC codes per image pixel), otherwise
 * from the dimension-calibration field of view (linear 0..DAC_MAX mapping).
 */
export function selectionPixelSize(
  global: PixelSize | null,
  selection: ROIRequest | null | undefined,
  fov: SelectionFov,
  edge: number,
): PixelSize | null {
  if (!global || !selection || !Number.isFinite(edge) || edge <= 0) return global;

  const dac = worldSelectionToDacROI(selection, fov);
  const pitchX = dacCodePitch(dac.x_start, dac.x_end, edge);
  const pitchY = dacCodePitch(dac.y_start, dac.y_end, edge);

  const geometry = fov.scanGeometry;
  let perCodeX: number;
  let perCodeY: number;
  if (global.source === "scanGeometry" && geometry?.enabled) {
    perCodeX = (global.x * geometry.pixels[0]) / DAC_CODES;
    perCodeY = (global.y * geometry.pixels[1]) / DAC_CODES;
  } else {
    perCodeX = Math.abs(fov.x_end - fov.x_origin) / DAC_MAX;
    perCodeY = Math.abs(fov.y_end - fov.y_origin) / DAC_MAX;
  }

  const x = perCodeX * pitchX;
  const y = perCodeY * pitchY;
  return validSize(x, y) ? { ...global, x, y } : global;
}

/**
 * Zoom of a partial ROI relative to the full DAC range: how many times
 * smaller the scanned area is. Magnification of the ROI scan is the base
 * magnification times this factor. Limited by the longer ROI side, since one
 * magnification must keep the whole ROI in view. Mirrors glasgow_service
 * roi_scaling.roi_zoom.
 */
export function selectionZoom(selection: ROIRequest | null | undefined, fov: SelectionFov): number {
  if (!selection) return 1;
  const dac = worldSelectionToDacROI(selection, fov);
  const spanX = Math.max(1, Math.abs(dac.x_end - dac.x_start) + 1);
  const spanY = Math.max(1, Math.abs(dac.y_end - dac.y_start) + 1);
  return Math.min(DAC_CODES / spanX, DAC_CODES / spanY);
}
