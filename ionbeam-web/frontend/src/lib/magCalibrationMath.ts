/**
 * Magnification-calibration arithmetic, shared by the MAG CAL panel and the store
 * so the number shown to the operator is the number that gets saved.
 *
 * The operator measures a feature of known length (`lengthM`) that spans `pixels`
 * image pixels in an image `resolution` pixels wide. That fixes the pixel size,
 * and the horizontal field of view (HFOV) is the pixel size times the image width.
 */
import { interpolateHfovM } from "./scanGeometry.js";

/** A new point may differ from the calibrated curve by this fraction before it is flagged. */
export const MAG_CURVE_TOLERANCE = 0.05;

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Size of one image pixel in metres, or 0 when the inputs are unusable. */
export function pixelSizeM(lengthM: number, pixels: number): number {
  return positive(lengthM) && positive(pixels) ? lengthM / pixels : 0;
}

/** HFOV in metres from the measured pixel size, or 0 when the inputs are unusable. */
export function hfovFromPixelSizeM(pixelSize: number, resolution: number): number {
  return positive(pixelSize) && positive(resolution) ? pixelSize * resolution : 0;
}

export function computeHfovM(lengthM: number, pixels: number, resolution: number): number {
  return hfovFromPixelSizeM(pixelSizeM(lengthM, pixels), resolution);
}

export interface CurveCheck {
  /** HFOV the existing curve predicts at this magnification, m. */
  expectedM: number;
  /** (measured - expected) / expected. */
  deviation: number;
  /** True when |deviation| exceeds the tolerance. */
  flagged: boolean;
}

/**
 * Compare a new measurement with the curve built from the *other* points.
 * HFOV is inversely proportional to magnification, so a point that is off the
 * curve usually means a mis-typed magnification, length or pixel count. Returns
 * null when there is nothing to compare with (empty curve) or the input is bad.
 */
export function checkAgainstCurve(
  points: Record<string, number>,
  mag: number,
  hfovM: number,
  tolerance: number = MAG_CURVE_TOLERANCE,
): CurveCheck | null {
  if (!positive(hfovM) || !positive(mag)) return null;
  const others: Record<string, number> = { ...points };
  delete others[String(Math.trunc(mag))];
  const expectedM = interpolateHfovM(others, mag);
  if (expectedM === null || !positive(expectedM)) return null;
  const deviation = (hfovM - expectedM) / expectedM;
  return { expectedM, deviation, flagged: Math.abs(deviation) > tolerance };
}

/** True when saving the point would replace an existing one at the same magnification. */
export function replacesPoint(points: Record<string, number>, mag: number): boolean {
  return Object.prototype.hasOwnProperty.call(points, String(Math.trunc(mag)));
}
