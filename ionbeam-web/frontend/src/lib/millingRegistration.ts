import type { LatticeRequest, ROIRequest } from "../types/api";
import { millingDacBounds, projectedDac, type MillingProjection } from "./millingLiveView.js";
import { patternBounds, type PatternRoi } from "./processingPatterns.js";
import { dacCodePitch } from "./pixelSize.js";
import { transform } from "./scanGeometry.js";

const DAC_MAX = 16383;
const MARGIN_UM = 1; // The exclusion is 2 µm wider and 2 µm taller than the ROI.
export const REGISTRATION_RESOLUTION = 256;

export function millingRegistrationBounds(roi: PatternRoi, field: MillingProjection): ROIRequest | null {
  const bounds = patternBounds(roi);
  const viewport = {
    x_start: Math.min(field.x_origin, field.x_end), x_end: Math.max(field.x_origin, field.x_end),
    y_start: Math.min(field.y_origin, field.y_end), y_end: Math.max(field.y_origin, field.y_end),
  };
  if (!Object.values(bounds).every(Number.isFinite) || !Object.values(viewport).every(Number.isFinite) ||
      bounds.x_start < viewport.x_start || bounds.x_end > viewport.x_end ||
      bounds.y_start < viewport.y_start || bounds.y_end > viewport.y_end ||
      bounds.x_end < bounds.x_start || bounds.y_end < bounds.y_start ||
      bounds.x_end - bounds.x_start + 2 * MARGIN_UM > viewport.x_end - viewport.x_start + 1e-9 ||
      bounds.y_end - bounds.y_start + 2 * MARGIN_UM > viewport.y_end - viewport.y_start + 1e-9) return null;
  const vertices = "points" in roi ? roi.points : [bounds.x_start, bounds.x_end].flatMap(x =>
    [bounds.y_start, bounds.y_end].map((y): [number, number] => [x, y]));
  if (vertices.some(([x, y]) => worldToDac(field, x, y).some(v => !Number.isFinite(v) || v < -1e-7 || v > DAC_MAX + 1e-7)))
    return null;
  return bounds;
}

function worldToDac(field: MillingProjection, x: number, y: number): [number, number] {
  if (field.scanGeometry?.enabled) return transform(field.scanGeometry.inverse, [x, y]);
  return [
    (x - Math.min(field.x_origin, field.x_end)) * DAC_MAX / Math.abs(field.x_end - field.x_origin),
    (y - Math.min(field.y_origin, field.y_end)) * DAC_MAX / Math.abs(field.y_end - field.y_origin),
  ];
}

function maxDacShift(field: MillingProjection): [number, number] {
  const zero = worldToDac(field, 0, 0);
  const diagonal = worldToDac(field, MARGIN_UM, MARGIN_UM);
  const cross = worldToDac(field, MARGIN_UM, -MARGIN_UM);
  return [Math.max(Math.abs(diagonal[0] - zero[0]), Math.abs(cross[0] - zero[0])),
    Math.max(Math.abs(diagonal[1] - zero[1]), Math.abs(cross[1] - zero[1]))];
}

export function millingReferenceStrips(bounds: ROIRequest, field: MillingProjection, lattices: readonly LatticeRequest[]): ROIRequest[] {
  const corners = [bounds.x_start - MARGIN_UM, bounds.x_end + MARGIN_UM].flatMap(x =>
    [bounds.y_start - MARGIN_UM, bounds.y_end + MARGIN_UM].map(y => worldToDac(field, x, y)));
  const latticeBounds = lattices.map(millingDacBounds);
  // Enclose the calibrated exclusion conservatively. Also exclude the actual
  // planned beam footprint if display geometry and DAC geometry differ.
  const [padX, padY] = maxDacShift(field);
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0]), ...latticeBounds.map(b => b.x_start - padX))));
  const x1 = Math.min(DAC_MAX, Math.ceil(Math.max(...corners.map(p => p[0]), ...latticeBounds.map(b => b.x_end + padX))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1]), ...latticeBounds.map(b => b.y_start - padY))));
  const y1 = Math.min(DAC_MAX, Math.ceil(Math.max(...corners.map(p => p[1]), ...latticeBounds.map(b => b.y_end + padY))));
  return [
    {x_start: 0, x_end: DAC_MAX, y_start: 0, y_end: y0 - 1},
    {x_start: 0, x_end: DAC_MAX, y_start: y1 + 1, y_end: DAC_MAX},
    {x_start: 0, x_end: x0 - 1, y_start: y0, y_end: y1},
    {x_start: x1 + 1, x_end: DAC_MAX, y_start: y0, y_end: y1},
  ].filter(b => b.x_end > b.x_start && b.y_end > b.y_start);
}

function encodeFrame(samples: Uint16Array): string {
  const parts: string[] = [];
  for (let i = 0; i < samples.length; i += 4096) {
    const bytes = new Uint8Array(Math.min(4096, samples.length - i) * 2);
    const view = new DataView(bytes.buffer);
    for (let j = 0; j < bytes.length / 2; j++) view.setUint16(j * 2, samples[i + j], true);
    parts.push(String.fromCharCode(...bytes));
  }
  return btoa(parts.join(""));
}

export function encodeRegistrationFrames(frames: readonly Uint16Array[]): string[] {
  return frames.map(encodeFrame);
}

export function registrationStrips(regions: readonly ROIRequest[], field: MillingProjection,
  reference: readonly string[], current: readonly string[]) {
  const maxShift = maxDacShift(field);
  const radius = (axis: 0 | 1, pitch: number) => Math.min(64,
    Math.max(3, Math.ceil(maxShift[axis] / pitch) + 2));
  return regions.map((bounds, i) => {
    const pitch_x = dacCodePitch(bounds.x_start, bounds.x_end, REGISTRATION_RESOLUTION);
    const pitch_y = dacCodePitch(bounds.y_start, bounds.y_end, REGISTRATION_RESOLUTION);
    return {reference: reference[i], current: current[i], pitch_x, pitch_y,
      radius_x: radius(0, pitch_x), radius_y: radius(1, pitch_y)};
  });
}

export function millingDriftUM([dx, dy]: [number, number], field: MillingProjection): [number, number] {
  const origin = projectedDac(0, 0, field);
  const shifted = projectedDac(dx, dy, field);
  return [shifted[0] - origin[0], shifted[1] - origin[1]];
}

export function millingOffset(value: unknown, field: MillingProjection): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) return null;
  const dac: [number, number] = [Math.round(value[0]), Math.round(value[1])];
  return millingDriftUM(dac, field).some(v => Math.abs(v) > MARGIN_UM + 1e-9) ? null : dac;
}

export function latticeFitsWithOffset(lattice: LatticeRequest, [dx, dy]: [number, number]): boolean {
  const b = millingDacBounds(lattice);
  return b.x_start + dx >= 0 && b.x_end + dx <= DAC_MAX && b.y_start + dy >= 0 && b.y_end + dy <= DAC_MAX;
}
