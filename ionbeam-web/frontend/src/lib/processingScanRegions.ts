import type { PatternRoi, PatternSpec } from "./processingPatterns";
import type { ROIState } from "../store/scanSlice";
import type { ROIRequest } from "../types/api";

/** Acquisition windows are rectangular; keep the pattern's geometry independent. */
export function processingScanRegions(specs: readonly Pick<PatternSpec, "key">[],
  instances: Record<string, { roi: PatternRoi | null; enabled?: boolean }>,
  field: Pick<ROIState, "x_origin" | "x_end" | "y_origin" | "y_end">,
): { keys: string[]; regions: ROIRequest[] } {
  const keys: string[] = [];
  const regions: ROIRequest[] = [];
  for (const spec of specs) {
    if (instances[spec.key]?.enabled === false) continue;
    const shape = instances[spec.key]?.roi;
    if (!shape) continue;
    let bounds: ROIRequest;
    if ("points" in shape) {
      if (!shape.points.length) continue;
      bounds = { x_start: Math.min(...shape.points.map(([x]) => x)), x_end: Math.max(...shape.points.map(([x]) => x)),
        y_start: Math.min(...shape.points.map(([, y]) => y)), y_end: Math.max(...shape.points.map(([, y]) => y)) };
    } else if ("cx" in shape) {
      const radius = "radius" in shape ? shape.radius : shape.r_outer;
      bounds = { x_start: shape.cx - radius, x_end: shape.cx + radius,
        y_start: shape.cy - radius, y_end: shape.cy + radius };
    } else bounds = { ...shape };
    bounds = { x_start: Math.max(Math.min(field.x_origin, field.x_end), bounds.x_start),
      x_end: Math.min(Math.max(field.x_origin, field.x_end), bounds.x_end),
      y_start: Math.max(Math.min(field.y_origin, field.y_end), bounds.y_start),
      y_end: Math.min(Math.max(field.y_origin, field.y_end), bounds.y_end) };
    if (!Object.values(bounds).every(Number.isFinite) || bounds.x_end <= bounds.x_start || bounds.y_end <= bounds.y_start) continue;
    keys.push(spec.key); regions.push(bounds);
  }
  return { keys, regions };
}

/** Regions acquired by a View scan: enabled pattern bounds plus any saved Scan-tab ROI areas. */
export function exposureViewScanRegions(specs: readonly Pick<PatternSpec, "key">[],
  instances: Record<string, { roi: PatternRoi | null; enabled?: boolean }>,
  field: ROIState,
): { keys: string[]; regions: ROIRequest[] } {
  const pattern = processingScanRegions(specs, instances, field);
  const keys = [...pattern.keys];
  const regions = [...pattern.regions];
  const scanROIs = field.roi_scan_enabled ? field.scan_regions : [];
  const selected = field.selection ? [field.selection] : [];
  const extras = [...scanROIs, ...selected];
  const seen = new Set(regions.map(regionKey));
  for (const [index, region] of extras.entries()) {
    const key = regionKey(region);
    if (!validRegion(region) || seen.has(key)) continue;
    seen.add(key);
    keys.push(`scan-roi-${index + 1}`);
    regions.push(region);
  }
  return { keys, regions };
}

function validRegion(region: ROIRequest): boolean {
  return Object.values(region).every(Number.isFinite) && region.x_end > region.x_start && region.y_end > region.y_start;
}

function regionKey(region: ROIRequest): string {
  return `${region.x_start},${region.x_end},${region.y_start},${region.y_end}`;
}
