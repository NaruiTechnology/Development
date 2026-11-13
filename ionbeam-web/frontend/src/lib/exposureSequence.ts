import { preparePatternExposure, simulationExposureSteps, stairExposureSteps } from "./patternExposure.js";
import type { ProcessingState } from "../store/processingSlice";
import type { ROIState } from "../store/scanSlice";
import type { LatticeRequest, VectorRequest } from "../types/api";
import type { WorkflowProgress } from "./processingWorkflows.js";

export interface ExposureEntry { key: string; node: WorkflowProgress; request: VectorRequest }
/** Aggregate guard for one selected exposure run. Mirrors the service's per-lattice sanity bound. */
export const MAX_EXPOSURE_SPOTS = 200_000_000;

export function totalExposureSpots(entries: readonly ExposureEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.node.total ?? entry.node.spot) * (entry.request.lattice?.passes ?? 1), 0);
}

export function prepareExposureSequence(patterns: ProcessingState, field: ROIState, simulation: boolean): ExposureEntry[] {
  if (!patterns.lensLookup) throw new Error("Load the LensLookup reference before exposure.");
  const entries: ExposureEntry[] = [];
  const order = new Map((patterns.roiCreationOrder ?? []).map((key, index) => [key, index]));
  const specs = [...patterns.specs].sort((a, b) => {
    const ai = order.get(a.key), bi = order.get(b.key);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
  for (const spec of specs) {
    const instance = patterns.instances[spec.key];
    if (!instance?.enabled || !instance.roi) continue;
    const stair = spec.model === "StairCutModel";
    const base = stair ? null : preparePatternExposure(spec, instance.roi, instance.parameters, patterns.lensLookup, field);
    // Stair cut is a per-step sequence in production too; Cleaning line stays simulation-only.
    const steps = stair ? stairExposureSteps(instance.roi, instance.parameters, instance.stairSteps, patterns.materials[0]?.name)
      : simulation ? simulationExposureSteps(spec, instance.roi, instance.parameters, base!.plan.spacingUM)
      : [{ shape: instance.roi, parameters: instance.parameters, caption: "Pattern exposure", requestedDepthUM: undefined, depthBand: undefined }];
    for (const [index, step] of steps.entries()) {
      const p = stair || simulation ? preparePatternExposure(spec, step.shape, step.parameters, patterns.lensLookup, field) : base!;
      entries.push({ key: spec.key, node: {
        id: `${spec.key}:${index}:exposure`, pattern: spec.caption, caption: step.caption, action: "Exposure lattice",
        status: "upcoming", threshold: null, spot: p.plan.count, total: p.plan.count,
        exposure: { shape: step.shape, model: spec.model, parameters: step.parameters, plan: p.plan, dwellUS: Number(step.parameters.dwell),
          beamCurrentPA: p.beamCurrentPA, requestedDepthUM: step.requestedDepthUM, depthBand: step.depthBand,
          material: step.material, incrementUM: step.incrementUM, removalRate: step.removalRate, after: step.after,
          lineSpacingUM: simulation && spec.model === "CleaningLineModel" ? Number(instance.parameters.spacing) : undefined, simulation },
      }, request: {
        pattern: "lattice", lattice: p.lattice, points: null, continuous: false, pre_process: false,
        scan_path: p.lattice.axis === "y" ? "vertical_serpentine" : "horizontal_triangle",
        vector_resolution: 2048, dwell: 0, latency_bytes: 4096, output_mode: "SixteenBit", adc_valid: true,
        cookie: 123, do_validate: true, feedback_mode: "standard",
      } });
    }
  }
  if (!entries.length) throw new Error("Enable at least one pattern with a drawn ROI before exposure.");
  return entries;
}

/** Parallel is pass interleaving on the single beam; dependencies within each pattern stay ordered.
 * The generator is lazy even for recipes with thousands of passes. */
export interface ExposureRun { entry: ExposureEntry; request: VectorRequest; final: boolean }

/** Yield one exposure pass per pattern in each round when Parallel is on.
 * The beam remains serial; the caller can interleave bounded cell segments. */
export function* exposureRounds(entries: ExposureEntry[], parallel: boolean): Generator<ExposureRun[]> {
  if (!parallel) {
    for (const entry of entries) {
      const passes = entry.request.lattice?.passes ?? 1;
      for (let pass = 0; pass < passes; pass++)
        yield [{entry, request: {...entry.request, lattice: {...entry.request.lattice!, passes: 1}}, final: pass === passes - 1}];
    }
    return;
  }
  if (entries.some(e => e.node.exposure?.model === "CleaningLineModel")) throw new Error("Cleaning lines require serial exposure (Parallel off).");
  const groups = new Map<string, ExposureEntry[]>();
  for (const e of entries) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
  const positions = [...groups.values()].map(steps => ({steps, index: 0, pass: 0}));
  while (positions.some(g => g.index < g.steps.length)) {
    const round: ExposureRun[] = [];
    for (const g of positions) {
      const entry = g.steps[g.index];
      if (!entry) continue;
      const final = ++g.pass >= entry.request.lattice!.passes;
      round.push({entry, request: {...entry.request, lattice: {...entry.request.lattice!, passes: 1}}, final});
      if (final) { g.index++; g.pass = 0; }
    }
    if (round.length) yield round;
  }
}

export function* exposureRuns(entries: ExposureEntry[], parallel: boolean): Generator<ExposureRun> {
  for (const round of exposureRounds(entries, parallel)) yield* round;
}

/** Direct cell ranges retain the original serpentine row parity and never replay earlier spots. */
export function* exposureSegments(lattice: LatticeRequest): Generator<LatticeRequest> {
  const shape = lattice.shape;
  let width: number, height: number;
  if (shape.kind === "rect") {
    width = Math.abs(shape.x1 - shape.x0); height = Math.abs(shape.y1 - shape.y0);
  } else if (shape.kind === "ellipse") {
    width = shape.rx * 2; height = shape.ry * 2;
  } else {
    const points = shape.kind === "frame" ? shape.outer : shape.points;
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    width = Math.max(...xs) - Math.min(...xs); height = Math.max(...ys) - Math.min(...ys);
  }
  const cells = Math.max(1, Math.round(width / lattice.pitch_x))
    * Math.max(1, Math.round(height / (lattice.pitch_y ?? lattice.pitch_x)));
  // At most 100 ms of programmed dwell, with a bounded host encoding workload.
  const size = Math.max(1, Math.min(131072, Math.floor(800000 / (lattice.dwell + 1))));
  for (let start = 0; start < cells; start += size)
    yield {...lattice, cell_start: start, cell_end: Math.min(cells, start + size)};
}

