import { buildLatticeRequest, linearDacMap, type DacMap } from "./latticeRequest.js";
import { lookupSpotSize, type LensLookup } from "./lensLookup.js";
import { planExposure, type ExposurePlan } from "./exposurePlan.js";
import { stairRects, patternBounds, type RectRoi, type PatternParameters, type PatternRoi, type PatternSpec } from "./processingPatterns.js";
import type { ROIState } from "../store/scanSlice";
import type { LatticeRequest } from "../types/api";
import { transform } from "./scanGeometry.js";
import { resolveStairSteps, stairIncrementUM, stairStepParameters, stairStepsError, type StairStepOverride } from "./stairRecipe.js";

export interface PreparedPatternExposure {
  plan: ExposurePlan;
  lattice: LatticeRequest;
  beamVoltageKV: number;
  beamCurrentPA: number;
  spotSizeNM: number;
}

/** Build a shape-only exposure plan. Scan zoom, ROI-scan state, image resolution, image dwell,
 * and image scan path are deliberately absent from this API. Pattern world coordinates are µm. */
export function preparePatternExposure(spec: PatternSpec, shape: PatternRoi, parameters: Record<string, unknown>,
  lookup: LensLookup, fov: Pick<ROIState, "x_origin" | "x_end" | "y_origin" | "y_end" | "scanGeometry">): PreparedPatternExposure {
  const beamCurrentPA = Number(parameters.beamCurrent);
  const dwellUS = Number(parameters.dwell);
  const overlapPct = Number(parameters.overlap);
  // `targetDose` (nC/um^2) is set only by Stair cut steps with a calibrated removal rate; passes then derive from it.
  const targetDose = parameters.targetDose === undefined ? undefined : Number(parameters.targetDose);
  const passes = targetDose === undefined ? Number(parameters.passes ?? 1) : undefined;
  const dose = targetDose ?? Number(parameters.dose ?? 1);
  const axis = parameters.axis === "y" ? "y" : "x";
  const beamVoltageKV = lookup.rows[0]?.beamVoltageKV;
  if (!beamVoltageKV) throw new Error("Lens lookup has no beam-voltage reference.");
  const spot = lookupSpotSize(lookup, beamVoltageKV, beamCurrentPA, false);
  if (spot.status !== "exact" || spot.spotSizeUM === null || spot.spotSizeNM === null)
    throw new Error(`${spec.caption}: no exact ${beamCurrentPA} pA spot-size reference at ${beamVoltageKV} kV.`);
  const widthUM = Math.abs(fov.x_end - fov.x_origin), heightUM = Math.abs(fov.y_end - fov.y_origin);
  const plan = planExposure(spec, shape, { beamCurrentPA, spotDiameterUM: spot.spotSizeUM, overlapPct, dwellUS, dose, passes },
    { axis, fieldWidthUM: widthUM });
  const map: DacMap = fov.scanGeometry?.enabled
    ? { linear: false, toDac: (x, y) => {
        const [dx, dy] = transform(fov.scanGeometry!.inverse, [x, y]);
        return { x: Math.max(0, Math.min(16383, dx)), y: Math.max(0, Math.min(16383, dy)) };
      } }
    : linearDacMap(fov);
  const lattice = buildLatticeRequest(shape, plan, Math.max(0, Math.min(65535, Math.ceil(dwellUS / 0.125) - 1)), map,
    { widthUM, heightUM }, axis);
  return { plan, lattice, beamVoltageKV, beamCurrentPA, spotSizeNM: spot.spotSizeNM };
}

export interface PatternExposureStep {
  shape: PatternRoi;
  parameters: PatternParameters;
  caption: string;
  requestedDepthUM?: number;
  depthBand?: RectRoi;
  /** Stair cut only: layer material label, depth this step adds, calibrated Sr (um^3/nC). */
  material?: string;
  incrementUM?: number;
  removalRate?: number;
  after?: "view" | "viewPause";
}

/** Stair cut: one nested exposure per enabled step, each with its own recipe (see stairRecipe.ts).
 * Step i exposes the box covering strips i..n, so strip k receives k layers and depths accumulate.
 * Used by simulation and production alike. */
export function stairExposureSteps(shape: PatternRoi, parameters: PatternParameters,
  overrides?: ReadonlyArray<StairStepOverride | null | undefined>, defaultMaterial?: string): PatternExposureStep[] {
  const strips = stairRects(shape as RectRoi, parameters);
  const recipe = resolveStairSteps(parameters, overrides).map(step => ({
    ...step,
    material: step.material || defaultMaterial || "",
  }));
  const error = stairStepsError(recipe);
  if (error) throw new Error(error);
  const out: PatternExposureStep[] = [];
  strips.forEach((strip, i) => {
    if (!recipe[i].enabled) return;
    const remaining = strips.slice(i);
    const box = { x_start: Math.min(...remaining.map(r => r.x_start)), x_end: Math.max(...remaining.map(r => r.x_end)),
      y_start: Math.min(...remaining.map(r => r.y_start)), y_end: Math.max(...remaining.map(r => r.y_end)) };
    out.push({ shape: box, depthBand: strip, parameters: stairStepParameters(parameters, recipe, i),
      caption: `Step ${i + 1} / ${strips.length}`, requestedDepthUM: recipe[i].depth,
      material: recipe[i].material || undefined, incrementUM: stairIncrementUM(recipe, i),
      removalRate: recipe[i].removalRate > 0 ? recipe[i].removalRate : undefined,
      after: recipe[i].after === "none" ? undefined : recipe[i].after });
  });
  return out;
}

/** Simulation choreography for Cleaning line; Stair cut delegates to `stairExposureSteps`.
 * Never changes production exposure recipes or calibrated depth. */
export function simulationExposureSteps(spec: PatternSpec, shape: PatternRoi, parameters: PatternParameters,
  spacingUM: number, stairOverrides?: ReadonlyArray<StairStepOverride | null | undefined>): PatternExposureStep[] {
  if (spec.model === "StairCutModel") return stairExposureSteps(shape, parameters, stairOverrides);
  if (spec.model === "CleaningLineModel") {
    const r = patternBounds(shape), vertical = parameters.orientation === "vertical";
    const spacing = Number(parameters.spacing);
    if (!(spacing > 0) || !Number.isFinite(spacing)) throw new Error("Clean line spacing must be positive.");
    const length = vertical ? r.x_end - r.x_start : r.y_end - r.y_start;
    const count = Math.max(0, Math.ceil(length / spacing - 0.5 - 1e-9));
    if (!count) throw new Error("No cleaning lines fit inside the pattern; reduce line spacing.");
    if (count > 1000) throw new Error("Simulation supports up to 1000 cleaning steps; increase line spacing.");
    // A single lattice row centred on each cleaning line, with no neighbouring-line overlap.
    const width = Math.min(spacingUM, spacing, length);
    return Array.from({ length: count }, (_, i) => {
      const center = (vertical ? r.x_start : r.y_start) + (i + 0.5) * spacing;
      const half = Math.min(width / 2, center - (vertical ? r.x_start : r.y_start),
        (vertical ? r.x_end : r.y_end) - center);
      return { shape: vertical ? { ...r, x_start: center - half, x_end: center + half }
        : { ...r, y_start: center - half, y_end: center + half },
        parameters: { ...parameters, axis: vertical ? "y" : "x" }, caption: `Line ${i + 1} / ${count}` };
    });
  }
  return [{ shape, parameters, caption: "Pattern exposure" }];
}

/** Planned beam-on time and lattice spots, using the same step expansion as Exposure Start. */
export function plannedPatternExposureMetrics(spec: PatternSpec, shape: PatternRoi, parameters: PatternParameters,
  lookup: LensLookup, fov: Pick<ROIState, "x_origin" | "x_end" | "y_origin" | "y_end" | "scanGeometry">,
  options: {simulation?: boolean; stairOverrides?: ReadonlyArray<StairStepOverride | null | undefined>; defaultMaterial?: string} = {}):
  {spotCount: number; beamOnS: number} {
  const stair = spec.model === "StairCutModel";
  const base = stair ? null : preparePatternExposure(spec, shape, parameters, lookup, fov);
  const steps = stair ? stairExposureSteps(shape, parameters, options.stairOverrides, options.defaultMaterial)
    : options.simulation ? simulationExposureSteps(spec, shape, parameters, base!.plan.spacingUM)
    : [{shape, parameters}];
  return steps.reduce((total, step) => {
    const plan = stair || options.simulation
      ? preparePatternExposure(spec, step.shape, step.parameters, lookup, fov).plan
      : base!.plan;
    return {spotCount: total.spotCount + plan.count, beamOnS: total.beamOnS + plan.beamOnS};
  }, {spotCount: 0, beamOnS: 0});
}
