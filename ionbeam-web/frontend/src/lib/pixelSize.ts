import type { DimensionCalibrationValues } from "./dimensionCalibrationPersistence";
import type { AppliedScanGeometry } from "./scanGeometry";

/** Physical size represented by one calibrated image pixel. */
export interface PixelSize {
  x: number;
  y: number;
  unit: string;
  source: "scanGeometry" | "dimensionCalibration";
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
