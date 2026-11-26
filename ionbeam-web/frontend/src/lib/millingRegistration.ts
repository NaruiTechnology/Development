import type { LatticeRequest, ROIRequest, ServerDefaults } from "../types/api";
import { millingDacBounds, projectedDac, type MillingProjection } from "./millingLiveView.js";
import { dacCodePitch } from "./pixelSize.js";
import { patternBounds, type PatternRoi } from "./processingPatterns.js";
import { transform } from "./scanGeometry.js";

const DAC_MAX = 16383;
export const DEFAULT_MILLING_DRIFT_LIMIT_UM = 2;
type RegistrationCapabilities = Pick<ServerDefaults, "milling_drift_registration" | "milling_registration_resolutions">;

export function millingRegistrationOptions(capabilities: RegistrationCapabilities | null): number[] {
  if (capabilities?.milling_drift_registration !== true) return [];
  // Older services advertise registration without a list and accept only 512.
  const advertised = capabilities.milling_registration_resolutions ?? [512];
  if (!Array.isArray(advertised)) return [];
  return [...new Set(advertised)]
    .filter(size => Number.isSafeInteger(size) && size > 1 && size <= 2048);
}

export function millingRegistrationSelection(options: number[], preferred: number | null): number | undefined {
  return preferred !== null && options.includes(preferred) ? preferred : options[0];
}

export function registrationPitch(resolution: number): number {
  return dacCodePitch(0, DAC_MAX, resolution);
}

function paddedBounds(bounds: ROIRequest, limitUm: number): ROIRequest {
  return {
    x_start: bounds.x_start - limitUm, x_end: bounds.x_end + limitUm,
    y_start: bounds.y_start - limitUm, y_end: bounds.y_end + limitUm,
  };
}

export function millingRegistrationBounds(roi: PatternRoi, field: MillingProjection, limitUm = DEFAULT_MILLING_DRIFT_LIMIT_UM): ROIRequest | null {
  const bounds = patternBounds(roi);
  if (!Object.values(bounds).every(Number.isFinite) || bounds.x_end < bounds.x_start || bounds.y_end < bounds.y_start)
    return null;
  const padded = paddedBounds(bounds, limitUm);
  const corners = [padded.x_start, padded.x_end].flatMap(x =>
    [padded.y_start, padded.y_end].map(y => worldToDac(field, x, y)));
  if (corners.some(point => point.some(v => !Number.isFinite(v) || v < -1e-7 || v > DAC_MAX + 1e-7))) return null;
  return bounds;
}

function worldToDac(field: MillingProjection, x: number, y: number): [number, number] {
  if (field.scanGeometry?.enabled) return transform(field.scanGeometry.inverse, [x, y]);
  return [
    (x - Math.min(field.x_origin, field.x_end)) * DAC_MAX / Math.abs(field.x_end - field.x_origin),
    (y - Math.min(field.y_origin, field.y_end)) * DAC_MAX / Math.abs(field.y_end - field.y_origin),
  ];
}

function maxDacShift(field: MillingProjection, limitUm: number): [number, number] {
  const zero = worldToDac(field, 0, 0);
  const diagonal = worldToDac(field, limitUm, limitUm);
  const cross = worldToDac(field, limitUm, -limitUm);
  return [Math.max(Math.abs(diagonal[0] - zero[0]), Math.abs(cross[0] - zero[0])),
    Math.max(Math.abs(diagonal[1] - zero[1]), Math.abs(cross[1] - zero[1]))];
}

export function registrationRadius(field: MillingProjection, axis: 0 | 1, resolution: number, limitUm = DEFAULT_MILLING_DRIFT_LIMIT_UM): number {
  const maxRadius = resolution / 2 + 2;
  return Math.min(maxRadius, Math.max(3, Math.ceil(maxDacShift(field, limitUm)[axis] / registrationPitch(resolution)) + 2));
}

export function encodeRegistrationFrame(samples: Uint16Array, mask: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < samples.length; i += 4096) {
    const bytes = new Uint8Array(Math.min(4096, samples.length - i) * 2);
    const view = new DataView(bytes.buffer);
    for (let j = 0; j < bytes.length / 2; j++) {
      if (mask[i + j]) view.setUint16(j * 2, samples[i + j], true);
    }
    parts.push(String.fromCharCode(...bytes));
  }
  return btoa(parts.join(""));
}

export function registrationMask(bounds: ROIRequest, field: MillingProjection, resolution: number, limitUm = DEFAULT_MILLING_DRIFT_LIMIT_UM): {pixels: Uint8Array; encoded: string} | null {
  const padded = paddedBounds(bounds, limitUm);
  const pitch = registrationPitch(resolution);
  const pixels = new Uint8Array(resolution ** 2);
  let included = 0;
  // Test the physical bounds at the actual raster DAC positions, including
  // when calibration rotates or shears the field.
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const [wx, wy] = projectedDac(x * pitch, y * pitch, field);
      if (wx < padded.x_start - 1e-9 || wx > padded.x_end + 1e-9 ||
          wy < padded.y_start - 1e-9 || wy > padded.y_end + 1e-9) {
        pixels[y * resolution + x] = 1;
        included++;
      }
    }
  }
  // The matcher requires at least one fifth of a frame in common.
  if (included < pixels.length / 5) return null;
  const chunks: string[] = [];
  for (let i = 0; i < pixels.length; i += 8192) chunks.push(String.fromCharCode(...pixels.subarray(i, i + 8192)));
  return {pixels, encoded: btoa(chunks.join(""))};
}

export function millingDriftUM([dx, dy]: [number, number], field: MillingProjection): [number, number] {
  const origin = projectedDac(0, 0, field);
  const shifted = projectedDac(dx, dy, field);
  return [shifted[0] - origin[0], shifted[1] - origin[1]];
}

export function millingOffset(measured: [number, number], field: MillingProjection, limitUm = DEFAULT_MILLING_DRIFT_LIMIT_UM): [number, number] | null {
  const dac: [number, number] = [Math.round(measured[0]), Math.round(measured[1])];
  const withinMargin = (offset: [number, number]) =>
    millingDriftUM(offset, field).every(v => Number.isFinite(v) && Math.abs(v) <= limitUm + 1e-9);
  return withinMargin(measured) && withinMargin(dac) ? dac : null;
}

export function latticeFitsWithOffset(lattice: LatticeRequest, [dx, dy]: [number, number]): boolean {
  const b = millingDacBounds(lattice);
  return b.x_start + dx >= 0 && b.x_end + dx <= DAC_MAX && b.y_start + dy >= 0 && b.y_end + dy <= DAC_MAX;
}
