import { MODEL_REGISTRY, type PatternSpec, type PatternRoi } from "./processingPatterns.js";
import { bitmapScanCoordinates } from "./vectorScanPath.js";
import type { ROIRequest, SimulationBitmap, VectorPointTuple, VectorScanPath } from "../types/api";

export interface WorkflowSpec {
  name: string; caption: string;
  steps: { name: string; caption: string; actions: {
    name: string; caption: string; mode: "scan" | "spot";
    selection?: "dark" | "bright"; thresholdMaterial?: string;
  }[] }[];
}
export const DEFAULT_WORKFLOW: WorkflowSpec = { name: "default", caption: "Default", steps: [
  { name: "scan", caption: "Scan ROI", actions: [{ name: "scan", caption: "Scan ROI", mode: "scan" }] },
] };
export interface WorkflowProgress {
  id: string; pattern: string; caption: string; action: string;
  status: "upcoming" | "current" | "completed" | "stopped" | "error";
  threshold: number | null; spot: number; total: number;
  startedAt?: number; finishedAt?: number;
}

/** Freeze one image and threshold for all steps, so dark and bright are complementary. */
export function workflowPoints(spec: PatternSpec, shape: PatternRoi, region: ROIRequest,
  field: ROIRequest, frame: Uint16Array, edge: number, workflow: WorkflowSpec,
  materials: { name: string; brightness: number }[], dwell: number, path: VectorScanPath,
  toDac?: (x: number, y: number) => { x: number; y: number },
): { step: WorkflowSpec["steps"][number]; points: VectorPointTuple[]; threshold: number | null; spot: number; simulationBitmap: SimulationBitmap; pointPixelIndices: number[] }[] {
  if (frame.length !== edge * edge || !frame.length) throw new Error("Workflow needs a complete source image.");
  const samples: { x: number; y: number; gray: number; inside: boolean; index: number }[] = [];
  let sum = 0, count = 0;
  let left = edge, right = 0, top = edge, bottom = 0;
  let dacLeft = 16383, dacRight = 0, dacTop = 16383, dacBottom = 0;
  for (const [x, y] of bitmapScanCoordinates(edge, edge, path)) {
    const wx = field.x_start + x / Math.max(1, edge - 1) * (field.x_end - field.x_start);
    const wy = field.y_start + y / Math.max(1, edge - 1) * (field.y_end - field.y_start);
    if (wx < region.x_start || wx > region.x_end || wy < region.y_start || wy > region.y_end) continue;
    const inside = MODEL_REGISTRY[spec.model].contains(shape, wx, wy);
    const gray = frame[y * edge + x] >>> 8;
    const dac = toDac?.(wx, wy);
    samples.push({ x: dac?.x ?? Math.round((wx - field.x_start) / (field.x_end - field.x_start) * 16383),
      y: dac?.y ?? Math.round((wy - field.y_start) / (field.y_end - field.y_start) * 16383), gray, inside, index: y * edge + x });
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    const sample = samples[samples.length - 1];
    dacLeft = Math.min(dacLeft, sample.x); dacRight = Math.max(dacRight, sample.x);
    dacTop = Math.min(dacTop, sample.y); dacBottom = Math.max(dacBottom, sample.y);
    if (samples.length > 250000) throw new Error("Workflow exceeds 250,000 vector points; reduce resolution or ROI size.");
    if (inside) { sum += gray; count++; }
  }
  if (!count) throw new Error(`${spec.caption}: ROI contains no source pixels at this resolution.`);
  if (samples.length > 250000) throw new Error("Workflow exceeds 250,000 vector points; reduce resolution or ROI size.");
  const pixels: number[] = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) pixels.push(frame[y * edge + x] >>> 8);
  // Even one sampled column/row needs a non-degenerate API ROI.
  if (dacLeft === dacRight) { if (dacRight < 16383) dacRight++; else dacLeft--; }
  if (dacTop === dacBottom) { if (dacBottom < 16383) dacBottom++; else dacTop--; }
  const simulationBitmap: SimulationBitmap = { width: right - left + 1, height: bottom - top + 1, pixels,
    source_roi: { x_start: dacLeft, x_end: dacRight, y_start: dacTop, y_end: dacBottom } };
  const pointPixelIndices = samples.map(sample => sample.index);
  return workflow.steps.map(step => {
    const action = step.actions[0];
    const ratio = materials.find(m => m.name === action.thresholdMaterial)?.brightness;
    if (action.mode === "spot" && (!ratio || !Number.isFinite(ratio))) throw new Error("Missing workflow material brightness.");
    const threshold = action.mode === "spot" ? sum / count * ratio! : null;
    let spot = 0;
    const points: VectorPointTuple[] = samples.map(p => {
      // Equality belongs to bright, ensuring Even covers every ROI pixel once.
      const active = p.inside && (threshold === null || (action.selection === "dark" ? p.gray < threshold : p.gray >= threshold));
      if (active) spot++;
      return [p.x, p.y, dwell, !active, active ? 1 : 2];
    });
    return { step, points, threshold, spot, simulationBitmap, pointPixelIndices };
  });
}

/** Finished steps keep their duration when another step starts or the UI refreshes. */
export function workflowElapsedMs(step: Pick<WorkflowProgress, "startedAt" | "finishedAt">, now: number): number {
  return step.startedAt === undefined ? 0 : Math.max(0, (step.finishedAt ?? now) - step.startedAt);
}

export function formatWorkflowElapsed(milliseconds: number): string {
  const tenths = Math.floor(Math.max(0, milliseconds) / 100);
  const seconds = Math.floor(tenths / 10);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours ? `${hours}:` : ""}${String(hours ? minutes % 60 : minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${tenths % 10}`;
}
