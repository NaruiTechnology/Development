import { MODEL_REGISTRY, patternBounds, type PatternRoi, type PatternSpec } from "./processingPatterns.js";
import type { VectorPointTuple } from "../types/api";

/**
 * Exposure planning in physical units.
 *
 * The beam, not the image, defines the pattern lattice: spot diameter d comes from the
 * lens table (beam current -> spot size), overlap OL = (d - s) / d sets the point spacing
 * s = d (1 - OL/100), and the pattern is covered by a serpentine lattice of beam spots
 * (FEI "Pattern Scan Strategy"). Image pixels and the vector_resolution edge play no part.
 *
 * Units: lengths um, current pA, dwell us, charge nC, dose nC/um^2, removal rate um^3/nC.
 * Pattern geometry is in canvas "world" units; `umPerWorld` converts (1 when world is um).
 */

/** Same bound as the legacy pixel workflow. The FIB manual allows 1e6 points per pattern. */
export const MAX_EXPOSURE_POINTS = 250_000;
/** Lattice cells examined for an exact count before falling back to area / s^2. */
const MAX_COUNT_CELLS = 4_000_000;
export const DAC_FULL_SCALE = 16383;

export type ScanAxis = "long" | "x" | "y";

export interface ExposureInputs {
  beamCurrentPA: number;
  spotDiameterUM: number;
  /** Percent. 50 = half-diameter advance, 0 = touching, negative = gaps (large gas patterns). */
  overlapPct: number;
  dwellUS: number;
  /** Target dose per unit area, nC/um^2. */
  dose: number;
  /** User override; when absent passes are derived from dose. */
  passes?: number;
}

/** s = d (1 - OL/100). OL must be < 100 or the beam would never advance. */
export function pointSpacingUM(spotDiameterUM: number, overlapPct: number): number {
  if (!(spotDiameterUM > 0) || !Number.isFinite(spotDiameterUM)) throw new Error("Spot diameter must be positive.");
  if (!Number.isFinite(overlapPct) || overlapPct >= 100) throw new Error("Overlap must be below 100%.");
  return spotDiameterUM * (1 - overlapPct / 100);
}

/** OL = (d - s) / d, as a percentage. */
export function overlapPctFromSpacing(spotDiameterUM: number, spacingUM: number): number {
  if (!(spotDiameterUM > 0) || !(spacingUM > 0)) throw new Error("Spot diameter and spacing must be positive.");
  return (spotDiameterUM - spacingUM) / spotDiameterUM * 100;
}

/** Charge delivered to one spot per pass: I [pA] * t [us] = 1e-6 nC per pA*us. */
export function chargePerSpotNC(beamCurrentPA: number, dwellUS: number): number {
  return beamCurrentPA * dwellUS * 1e-6;
}

/** Dose from one pass over a lattice of pitch s: every spot owns an s x s cell. */
export function dosePerPass(beamCurrentPA: number, dwellUS: number, spacingUM: number): number {
  return chargePerSpotNC(beamCurrentPA, dwellUS) / (spacingUM * spacingUM);
}

export function passesForDose(targetDose: number, dosePerPassValue: number): number {
  if (!(dosePerPassValue > 0)) throw new Error("Beam current and dwell must be positive.");
  return Math.max(1, Math.ceil(targetDose / dosePerPassValue - 1e-9));
}

/** Depth <-> dose needs a calibrated removal rate Sr (um^3/nC): depth = dose * Sr. */
export function doseFromDepth(depthUM: number, removalRateUM3PerNC: number): number {
  if (!(removalRateUM3PerNC > 0)) throw new Error("A calibrated removal rate is required to convert depth to dose.");
  return depthUM / removalRateUM3PerNC;
}
export function depthFromDose(dose: number, removalRateUM3PerNC: number): number {
  if (!(removalRateUM3PerNC > 0)) throw new Error("A calibrated removal rate is required to convert dose to depth.");
  return dose * removalRateUM3PerNC;
}

export interface LatticeSpec {
  nx: number; ny: number;
  /** Actual pitches in world units; adjusted slightly so a whole number of spots fits the bounds. */
  pitchX: number; pitchY: number;
  x0: number; y0: number;
  axis: "x" | "y";
}

export function latticeSpec(shape: PatternRoi, pitchWorld: number, axis: ScanAxis = "long"): LatticeSpec {
  if (!(pitchWorld > 0) || !Number.isFinite(pitchWorld)) throw new Error("Lattice pitch must be positive.");
  const b = patternBounds(shape);
  const w = b.x_end - b.x_start, h = b.y_end - b.y_start;
  const nx = Math.max(1, Math.round(w / pitchWorld)), ny = Math.max(1, Math.round(h / pitchWorld));
  return { nx, ny, pitchX: w / nx, pitchY: h / ny, x0: b.x_start, y0: b.y_start,
    axis: axis === "long" ? (w >= h ? "x" : "y") : axis };
}

const cellCentre = (l: LatticeSpec, i: number, j: number): [number, number] =>
  [l.x0 + (i + 0.5) * l.pitchX, l.y0 + (j + 0.5) * l.pitchY];

/** Spots start at the high-Y edge; the fast axis reverses on every row. */
export function* latticeCells(l: LatticeSpec): Generator<[number, number]> {
  const [fast, slow] = l.axis === "x" ? [l.nx, l.ny] : [l.ny, l.nx];
  for (let s = 0; s < slow; s++) for (let f = 0; f < fast; f++) {
    const k = s % 2 ? fast - 1 - f : f;
    yield l.axis === "x" ? [k, l.ny - 1 - s] : [s, l.ny - 1 - k];
  }
}

export interface SpotCount { count: number; exact: boolean }

/** Spots inside the true shape. Falls back to area / pitch^2 for lattices too large to walk. */
export function countSpots(spec: Pick<PatternSpec, "model">, shape: PatternRoi, l: LatticeSpec,
  parameters: Record<string, unknown> = {}): SpotCount {
  const model = MODEL_REGISTRY[spec.model];
  if (l.nx * l.ny > MAX_COUNT_CELLS) {
    return { count: Math.max(1, Math.round(model.area(shape, parameters) / (l.pitchX * l.pitchY))), exact: false };
  }
  let count = 0;
  for (let j = 0; j < l.ny; j++) for (let i = 0; i < l.nx; i++) {
    const [x, y] = cellCentre(l, i, j);
    if (model.contains(shape, x, y, parameters)) count++;
  }
  return { count, exact: true };
}

/** World-space beam spots, in scan order, clipped to the actual pattern shape. */
export function exposureSpots(spec: Pick<PatternSpec, "caption" | "model">, shape: PatternRoi, l: LatticeSpec,
  maxPoints = MAX_EXPOSURE_POINTS): [number, number][] {
  const model = MODEL_REGISTRY[spec.model];
  if (l.nx * l.ny > maxPoints * 64) throw new Error(`${spec.caption}: exposure exceeds ${maxPoints.toLocaleString()} points; raise overlap spacing or reduce the pattern.`);
  const spots: [number, number][] = [];
  for (const [i, j] of latticeCells(l)) {
    const p = cellCentre(l, i, j);
    if (!model.contains(shape, p[0], p[1])) continue;
    if (spots.length >= maxPoints) throw new Error(`${spec.caption}: exposure exceeds ${maxPoints.toLocaleString()} points; raise overlap spacing or reduce the pattern.`);
    spots.push(p);
  }
  if (!spots.length) throw new Error(`${spec.caption}: no beam spots fall inside the pattern; spot spacing is larger than the pattern.`);
  return spots;
}

export interface ExposurePlan {
  spotDiameterUM: number;
  spacingUM: number;
  overlapPct: number;
  lattice: LatticeSpec;
  count: number;
  countExact: boolean;
  dosePerPass: number;
  passes: number;
  /** Dose actually delivered after rounding passes up. */
  deliveredDose: number;
  /** Beam-on time, s: count * dwell * passes. Excludes settling and blanking overhead. */
  beamOnS: number;
  warnings: string[];
}

export interface PlanContext {
  /** Pattern units -> um. Default 1. */
  umPerWorld?: number;
  axis?: ScanAxis;
  /** Field width in um, used to flag spacing finer than one DAC step. */
  fieldWidthUM?: number;
  parameters?: Record<string, unknown>;
}

export function planExposure(spec: Pick<PatternSpec, "model">, shape: PatternRoi, input: ExposureInputs, ctx: PlanContext = {}): ExposurePlan {
  const umPerWorld = ctx.umPerWorld ?? 1;
  if (!(umPerWorld > 0)) throw new Error("World-to-um scale must be positive.");
  for (const [name, v] of [["Beam current", input.beamCurrentPA], ["Dwell", input.dwellUS], ["Dose", input.dose]] as const)
    if (!(v > 0) || !Number.isFinite(v)) throw new Error(`${name} must be a positive number.`);
  const spacingUM = pointSpacingUM(input.spotDiameterUM, input.overlapPct);
  const lattice = latticeSpec(shape, spacingUM / umPerWorld, ctx.axis);
  const { count, exact } = countSpots(spec, shape, lattice, ctx.parameters);
  // Dose is delivered per actual cell area, which differs slightly from s^2 after pitch adjustment.
  const cellUM2 = lattice.pitchX * lattice.pitchY * umPerWorld * umPerWorld;
  const perPass = chargePerSpotNC(input.beamCurrentPA, input.dwellUS) / cellUM2;
  const passes = input.passes ?? passesForDose(input.dose, perPass);
  const warnings: string[] = [];
  if (ctx.fieldWidthUM && spacingUM < ctx.fieldWidthUM / DAC_FULL_SCALE)
    warnings.push("Spot spacing is finer than one DAC step; neighbouring spots collapse onto the same DAC code.");
  if (!exact) warnings.push("Spot count is estimated from area; the lattice is too large to enumerate.");
  if (input.overlapPct < 0) warnings.push("Negative overlap leaves gaps between spots (large gas patterns only).");
  return { spotDiameterUM: input.spotDiameterUM, spacingUM, overlapPct: input.overlapPct, lattice, count, countExact: exact,
    dosePerPass: perPass, passes, deliveredDose: perPass * passes,
    beamOnS: count * input.dwellUS * 1e-6 * passes, warnings };
}

/** Beam-spot vector points ready for the DAC: [x, y, dwellTicks, blanked=false, flag=1].
 * Spots that land on the same DAC code are merged and their dwell summed (ticks = conversions - 1),
 * so the delivered charge is preserved even when spacing is finer than one DAC step. */
export function exposureVectorPoints(spots: readonly (readonly [number, number])[], dwellTicks: number,
  toDac: (x: number, y: number) => { x: number; y: number }): VectorPointTuple[] {
  const out: VectorPointTuple[] = [];
  let lx = NaN, ly = NaN;
  for (const [wx, wy] of spots) {
    const { x, y } = toDac(wx, wy);
    if (x === lx && y === ly && out[out.length - 1][2] + dwellTicks + 1 <= 65535) {
      const last = out[out.length - 1];
      last[2] += dwellTicks + 1;
      continue;
    }
    out.push([x, y, dwellTicks, false, 1]);
    lx = x; ly = y;
  }
  return out;
}
