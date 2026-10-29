export interface ImageExtent {
  x: number;
  y: number;
  unit: string;
}

/** A readable 1/2/5 scale occupying at most one quarter of the image width. */
export function imageScale(extent: ImageExtent | null, rotate90 = false) {
  if (!extent) return null;
  const span = rotate90 ? extent.y : extent.x;
  if (!Number.isFinite(span) || span <= 0) return null;
  const target = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const value = [5, 2, 1].map((step) => step * magnitude).find((step) => step <= target);
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
  return { fraction: value / span, label: `${Number(displayValue.toPrecision(4))} ${unit}` };
}
