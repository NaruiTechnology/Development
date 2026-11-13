import { MODEL_REGISTRY, type PatternRoi } from "./processingPatterns.js";
import type { LatticeSpec } from "./exposurePlan.js";

export interface PreviewSpot { x: number; y: number; order: number; connect: boolean }

/** Bounded sampling of real lattice centres, preserving row direction and shape clipping.
 * order is the normalized cell traversal position; dense/clipped previews are schematic. */
export function sampleExposureLattice(model: string, shape: PatternRoi, l: LatticeSpec, limit = 2000,
  parameters: Record<string, unknown> = {}): PreviewSpot[] {
  const fast = l.axis === "x" ? l.nx : l.ny, slow = l.axis === "x" ? l.ny : l.nx;
  const budget = Math.max(1, Math.floor(limit));
  const rows = Math.min(slow, Math.max(1, Math.floor(Math.sqrt(budget))));
  const columns = Math.min(fast, Math.max(1, Math.floor(budget / rows)));
  const out: PreviewSpot[] = [];
  const contains = MODEL_REGISTRY[model].contains;
  let previousRow = -2;
  let endedAtRowEnd = false;
  for (let r = 0; r < rows; r++) {
    const s = rows === 1 ? 0 : Math.round(r * (slow - 1) / (rows - 1));
    let previous = -1;
    for (let c = 0; c < columns; c++) {
      const f = columns === 1 ? 0 : Math.round(c * (fast - 1) / (columns - 1));
      const k = s % 2 ? fast - 1 - f : f;
      const [i, j] = l.axis === "x" ? [k, s] : [s, s % 2 ? l.ny - 1 - k : k];
      const x = l.x0 + (i + 0.5) * l.pitchX, y = l.y0 + (j + 0.5) * l.pitchY;
      if (!contains(shape, x, y, parameters)) { previous = -1; continue; }
      // Never draw a bridge across clipped geometry; polygons may be concave.
      const withinRow = previous >= 0 && ((model !== "PolygonModel" && model !== "FreeHandModel" && model !== "RingModel") || f === previous + 1);
      const rowTurn = model !== "RingModel" && c === 0 && f === 0 && previousRow === s - 1 && endedAtRowEnd;
      const connect = withinRow || rowTurn;
      out.push({ x, y, order: (s * fast + f + 1) / (fast * slow), connect });
      previous = f;
    }
    endedAtRowEnd = previous === fast - 1;
    previousRow = s;
  }
  return out;
}

export function exposureTraceFraction(received: number, count: number, completed: boolean): number {
  if (completed) return 1;
  // Keep the first-pass footprint visible while later passes repeat it.
  return Math.min(1, Math.max(0, received / Math.max(1, count)));
}

/** The marker wraps on each pass while the accumulated trace remains visible. */
export function exposureHeadFraction(received: number, count: number): number {
  if (!(received > 0 && count > 0)) return 0;
  const fraction = (received % count) / count;
  return fraction === 0 ? 1 : fraction;
}
