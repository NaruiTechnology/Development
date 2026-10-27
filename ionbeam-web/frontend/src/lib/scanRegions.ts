import type { ROIRequest } from "../types/api";

export interface ScanRegionFov {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
}

export interface ScanPixelBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Map a DAC ROI to the pixel rectangle it covers in a full-frame image. */
export function scanRegionPixelBounds(region: ROIRequest | null, edge: number): ScanPixelBounds {
  const size = Math.max(1, Math.trunc(edge));
  if (!region) return { x0: 0, x1: size, y0: 0, y1: size };

  const x0Dac = Math.min(region.x_start, region.x_end);
  const x1Dac = Math.max(region.x_start, region.x_end);
  const y0Dac = Math.min(region.y_start, region.y_end);
  const y1Dac = Math.max(region.y_start, region.y_end);
  const x0 = Math.max(0, Math.min(size - 1, Math.floor((x0Dac / 16383) * size)));
  const y0 = Math.max(0, Math.min(size - 1, Math.floor((y0Dac / 16383) * size)));
  const x1 = Math.max(x0 + 1, Math.min(size, Math.ceil((x1Dac / 16383) * size)));
  const y1 = Math.max(y0 + 1, Math.min(size, Math.ceil((y1Dac / 16383) * size)));
  return { x0, x1, y0, y1 };
}

/** Map one ROI-local scan sample to its destination in the full-frame buffer. */
export function mapScanPixelIndexToFrame(
  bounds: ScanPixelBounds,
  edge: number,
  x: number,
  y: number,
): number {
  const size = Math.max(1, Math.trunc(edge));
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  const targetX = bounds.x0 + Math.min(width - 1, Math.floor((x * width) / size));
  const targetY = bounds.y0 + Math.min(height - 1, Math.floor((y * height) / size));
  return targetY * size + targetX;
}

export function clampScanZoom(value: unknown): number {
  const zoom = Number(value);
  return Number.isFinite(zoom) ? Math.max(1, Math.min(1000, Math.trunc(zoom))) : 1;
}

/** Apply magnification around the centre of a scan area or selected ROI. */
export function zoomScanRegion(
  region: ROIRequest | null,
  zoomValue: number,
  fov: ScanRegionFov,
): ROIRequest | null {
  const zoom = clampScanZoom(zoomValue);
  if (!region && zoom === 1) return null;
  const base = region ?? {
    x_start: Math.min(fov.x_origin, fov.x_end),
    x_end: Math.max(fov.x_origin, fov.x_end),
    y_start: Math.min(fov.y_origin, fov.y_end),
    y_end: Math.max(fov.y_origin, fov.y_end),
  };
  const cx = (base.x_start + base.x_end) / 2;
  const cy = (base.y_start + base.y_end) / 2;
  const halfWidth = Math.abs(base.x_end - base.x_start) / (2 * zoom);
  const halfHeight = Math.abs(base.y_end - base.y_start) / (2 * zoom);
  return {
    x_start: cx - halfWidth,
    x_end: cx + halfWidth,
    y_start: cy - halfHeight,
    y_end: cy + halfHeight,
  };
}

/** One request region per selected area; without selections Zoom targets the full FOV. */
export function effectiveScanRegions(
  regions: ROIRequest[],
  zoom: number,
  fov: ScanRegionFov,
): Array<ROIRequest | null> {
  const source: Array<ROIRequest | null> = regions.length ? regions : [null];
  return source.map((region) => zoomScanRegion(region, zoom, fov));
}

