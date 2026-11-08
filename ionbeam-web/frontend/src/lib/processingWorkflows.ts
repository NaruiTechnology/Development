import { MODEL_REGISTRY, type PatternSpec, type PatternRoi } from "./processingPatterns.js";
import { ROI_TARGET_GRAY_STEP } from "./roiTargetGray.js";
import { bitmapScanCoordinates } from "./vectorScanPath.js";
import type { ROIRequest, SimulationBitmap, VectorPointTuple, VectorScanPath } from "../types/api";

export interface WorkflowSpec {
  name: string; caption: string;
  steps: { caption: string; actions: {
    caption: string; mode: "scan" | "spot";
    selection?: "dark" | "bright"; thresholdMaterial?: string; thresholdSource?: "fullScaleAverage" | "selectedMaterial" | "roiAverage";
  }[] }[];
}
export const DEFAULT_WORKFLOW: WorkflowSpec = { name: "default", caption: "Default", steps: [
  { caption: "Scan ROI", actions: [{ caption: "Scan ROI", mode: "scan" }] },
] };
export interface WorkflowProgress {
  id: string; pattern: string; caption: string; action: string;
  status: "upcoming" | "current" | "completed" | "stopped" | "error";
  threshold: number | null; spot: number; total: number;
  startedAt?: number; finishedAt?: number;
}

export function materialTargetGrayLevel(avgGray: number, brightness: number): number {
  return Math.max(0, Math.min(255, Math.round(avgGray * brightness)));
}

/** Freeze one source frame and threshold for all workflow steps. */
export function workflowPoints(spec: PatternSpec, shape: PatternRoi, region: ROIRequest,
  field: ROIRequest, frame: Uint16Array, edge: number, workflow: WorkflowSpec,
  materials: { name: string; brightness: number }[], dwell: number, path: VectorScanPath,
  toDac?: (x: number, y: number) => { x: number; y: number },
  selectedMaterial?: string,
): { step: WorkflowSpec["steps"][number]; points: VectorPointTuple[]; threshold: number | null; targetGrayFrames: number;
  grayRange: [number, number] | null; spot: number; simulationBitmap: SimulationBitmap; pointPixelIndices: number[] }[] {
  if (frame.length !== edge * edge || !frame.length) throw new Error("Workflow needs a complete source image.");
  const samples: { x: number; y: number; gray: number; inside: boolean; index: number }[] = [];
  let fullScaleSum = 0;
  for (const value of frame) fullScaleSum += value >>> 8;
  const fullScaleAverage = Math.round(fullScaleSum / frame.length);
  let sum = 0, count = 0;
  let maxGray = 0;
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
    if (inside) {
      sum += gray;
      count++;
      maxGray = Math.max(maxGray, gray);
    }
  }
  if (!count) throw new Error(`${spec.caption}: ROI contains no source pixels at this resolution.`);
  if (samples.length > 250000) throw new Error("Workflow exceeds 250,000 vector points; reduce resolution or ROI size.");
  const pixels: SimulationBitmap["pixels"] = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const wx = field.x_start + x / Math.max(1, edge - 1) * (field.x_end - field.x_start);
    const wy = field.y_start + y / Math.max(1, edge - 1) * (field.y_end - field.y_start);
    const insideRegion = wx >= region.x_start && wx <= region.x_end && wy >= region.y_start && wy <= region.y_end;
    const value = frame[y * edge + x] >>> 8;
    pixels.push(insideRegion && MODEL_REGISTRY[spec.model].contains(shape, wx, wy)
      ? value : { value, isSkipped: true });
  }
  // Even one sampled column/row needs a non-degenerate API ROI.
  if (dacLeft === dacRight) { if (dacRight < 16383) dacRight++; else dacLeft--; }
  if (dacTop === dacBottom) { if (dacBottom < 16383) dacBottom++; else dacTop--; }
  const simulationBitmap: SimulationBitmap = { width: right - left + 1, height: bottom - top + 1, pixels,
    source_roi: { x_start: dacLeft, x_end: dacRight, y_start: dacTop, y_end: dacBottom } };
  const pointPixelIndices = samples.map(sample => sample.index);
  const avgGray = sum / count;
  return workflow.steps.map(step => {
    const action = step.actions[0];
    const materialName = action.thresholdSource === "selectedMaterial" ? selectedMaterial : action.thresholdMaterial;
    const ratio = materials.find(m => m.name === materialName)?.brightness;
    if (action.mode === "spot" && action.thresholdSource !== "fullScaleAverage" && action.thresholdSource !== "roiAverage" && (!ratio || !Number.isFinite(ratio)))
      throw new Error("Missing workflow material brightness.");
    const threshold = action.mode !== "spot" ? null
      : action.thresholdSource === "fullScaleAverage" ? fullScaleAverage
      : action.thresholdSource === "selectedMaterial" ? materialTargetGrayLevel(avgGray, ratio!)
      : action.thresholdSource === "roiAverage" ? Math.round(avgGray)
      : avgGray * ratio!;
    const grayRange: [number, number] | null = action.thresholdSource === "roiAverage" && threshold !== null
      ? action.selection === "dark" ? [0, threshold] : [threshold, 255]
      : null;
    // AreaRemoval follows the ROI target-gray loop's two-level-per-pass convergence cadence.
    const targetGrayFrames = (action.thresholdSource === "selectedMaterial" || action.thresholdSource === "fullScaleAverage") && threshold !== null
      ? Math.max(1, Math.ceil(Math.max(0, maxGray - threshold) / ROI_TARGET_GRAY_STEP) + 1)
      : 1;
    let spot = 0;
    const actionSamples = action.thresholdSource === "fullScaleAverage" || action.thresholdSource === "roiAverage"
      ? samples.filter(p => p.inside) : samples;
    const points: VectorPointTuple[] = actionSamples.map(p => {
      const active = p.inside && (threshold === null || (action.selection === "dark"
        ? action.thresholdSource === "roiAverage" ? p.gray <= threshold : p.gray < threshold
        : action.thresholdSource === "fullScaleAverage" || action.thresholdSource === "selectedMaterial" ? p.gray > threshold : p.gray >= threshold));
      if (active) spot++;
      return [p.x, p.y, action.thresholdSource === "fullScaleAverage" ? Math.max(2, dwell) : dwell,
        !active, active ? 1 : 2];
    });
    return { step, points, threshold, targetGrayFrames, grayRange, spot, simulationBitmap,
      pointPixelIndices: action.thresholdSource === "fullScaleAverage" || action.thresholdSource === "roiAverage"
        ? actionSamples.map(sample => sample.index) : pointPixelIndices };
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
