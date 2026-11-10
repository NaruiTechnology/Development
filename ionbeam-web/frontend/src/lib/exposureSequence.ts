import { preparePatternExposure, simulationExposureSteps } from "./patternExposure.js";
import type { ProcessingState } from "../store/processingSlice";
import type { ROIState } from "../store/scanSlice";
import type { VectorRequest } from "../types/api";
import type { WorkflowProgress } from "./processingWorkflows.js";

export interface ExposureEntry { key: string; node: WorkflowProgress; request: VectorRequest }
export function prepareExposureSequence(patterns: ProcessingState, field: ROIState, simulation: boolean): ExposureEntry[] {
  if (!patterns.lensLookup) throw new Error("Load the LensLookup reference before exposure.");
  const entries: ExposureEntry[] = [];
  for (const spec of patterns.specs) {
    const instance = patterns.instances[spec.key];
    if (!instance?.enabled || !instance.roi) continue;
    const base = preparePatternExposure(spec, instance.roi, instance.parameters, patterns.lensLookup, field);
    const steps = simulation ? simulationExposureSteps(spec, instance.roi, instance.parameters, base.plan.spacingUM)
      : [{ shape: instance.roi, parameters: instance.parameters, caption: "Pattern exposure", requestedDepthUM: undefined, depthBand: undefined }];
    for (const [index, step] of steps.entries()) {
      const p = simulation ? preparePatternExposure(spec, step.shape, step.parameters, patterns.lensLookup, field) : base;
      entries.push({ key: spec.key, node: {
        id: `${spec.key}:${index}:exposure`, pattern: spec.caption, caption: step.caption, action: "Exposure lattice",
        status: "upcoming", threshold: null, spot: p.plan.count, total: p.plan.count,
        exposure: { shape: step.shape, model: spec.model, plan: p.plan, dwellUS: Number(step.parameters.dwell),
          beamCurrentPA: p.beamCurrentPA, requestedDepthUM: step.requestedDepthUM, depthBand: step.depthBand,
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
export function* exposureRuns(entries: ExposureEntry[], parallel: boolean): Generator<{entry: ExposureEntry; request: VectorRequest; final: boolean}> {
  if (!parallel) {
    for (const entry of entries) yield {entry, request: entry.request, final: true};
    return;
  }
  if (entries.some(e => e.node.exposure?.model === "CleaningLineModel")) throw new Error("Cleaning lines require serial exposure (Parallel off).");
  const groups = new Map<string, ExposureEntry[]>();
  for (const e of entries) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
  const positions = [...groups.values()].map(steps => ({steps, index: 0, pass: 0}));
  while (positions.some(g => g.index < g.steps.length)) for (const g of positions) {
    const entry = g.steps[g.index];
    if (!entry) continue;
    const final = ++g.pass >= entry.request.lattice!.passes;
    yield {entry, request: {...entry.request, lattice: {...entry.request.lattice!, passes: 1}}, final};
    if (final) { g.index++; g.pass = 0; }
  }
}
