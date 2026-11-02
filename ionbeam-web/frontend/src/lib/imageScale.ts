export interface ImageExtent {
  x: number;
  y: number;
  unit: string;
}

export interface FullFieldImageExtentSource {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  scale_unit: string;
  scanGeometry?: { enabled?: boolean; pixels?: [number, number] } | null;
}

export interface FullFieldImageExtentPixelSize {
  source?: string | null;
  x: number;
  y: number;
  unit: string;
}

export function fullCanvasImageExtent(
  roi: FullFieldImageExtentSource,
  globalPixelSize?: FullFieldImageExtentPixelSize | null,
): ImageExtent | null {
  if (globalPixelSize?.source === "scanGeometry" && roi.scanGeometry?.enabled) {
    const pixels = roi.scanGeometry.pixels ?? [0, 0];
    const x = Number(globalPixelSize.x) * Number(pixels[0]);
    const y = Number(globalPixelSize.y) * Number(pixels[1]);
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      return { x: Math.abs(x), y: Math.abs(y), unit: globalPixelSize.unit || roi.scale_unit };
    }
  }

  const x = Math.abs(Number(roi.x_end) - Number(roi.x_origin));
  const y = Math.abs(Number(roi.y_end) - Number(roi.y_origin));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  return { x, y, unit: roi.scale_unit };
}

/** Readable bar values per decade, largest first. */
const SCALE_STEPS = [8, 6, 5, 4, 3, 2, 1.5, 1];

/** A readable scale occupying at most one quarter of the image width. */
export function imageScale(extent: ImageExtent | null, rotate90 = false) {
  if (!extent) return null;
  const span = rotate90 ? extent.y : extent.x;
  if (!Number.isFinite(span) || span <= 0) return null;
  const target = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const value = SCALE_STEPS.map((step) => step * magnitude).find((step) => step <= target);
  if (!value || !Number.isFinite(value)) return null;
  const metres: Record<string, number> = { m: 1, mm: 1e-3, um: 1e-6, "µm": 1e-6, "μm": 1e-6, nm: 1e-9 };
  let displayValue = value;
  let unit = extent.unit;
  if (metres[unit]) {
    const length = value * metres[unit];
    const best = ([["m", 1], ["mm", 1e-3], ["µm", 1e-6], ["nm", 1e-9]] as const)
      .find(([, factor]) => length >= factor * (1 - 1e-12)) ?? ["nm", 1e-9];
    unit = best[0];
    displayValue = length / best[1];
  }
  return { fraction: value / span, label: `${displayValue.toFixed(1)} ${unit}` };
}
