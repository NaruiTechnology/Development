/**
 * Processing tab pattern models (pure TypeScript, no React / Redux).
 *
 * The catalogue comes from GET /api/processing/patterns (GlasgowDataIO/Json/processingPatterns.json). Each entry names
 * a data model in MODEL_REGISTRY below; the model knows the ROI shape the operator draws, validates it and derives its
 * area and preview geometry. ROIs are in world coordinates (the ROI canvas' units), so they survive zoom and image
 * changes.
 *
 *   rect     { x_start, x_end, y_start, y_end }                      ordered
 *   circle   { cx, cy, radius }                                    solid disk
 *   ring     { cx, cy, r_inner, r_outer }                           two concentric circles
 *   polygon  { points: [x, y][] }                                   at least three points
 */
export type RoiKind = "rect" | "circle" | "ring" | "polygon";
export type ParameterType = "int" | "float" | "bool" | "choice";
export type ParameterValue = number | boolean | string;

export interface ParameterSpec {
  name: string;
  label: string;
  type: ParameterType;
  default: ParameterValue;
  min: number | null;
  max: number | null;
  step: number;
  unit: string;
  choices: string[];
}

export interface PatternSpec {
  key: string;
  model: string;
  caption: string;
  icon: string;
  roi: RoiKind;
  parameters: ParameterSpec[];
}

export interface RectRoi { x_start: number; x_end: number; y_start: number; y_end: number }
export interface RingRoi { cx: number; cy: number; r_inner: number; r_outer: number }
export interface CircleRoi { cx: number; cy: number; radius: number }
export interface PolygonRoi { points: [number, number][] }
export type PatternRoi = RectRoi | CircleRoi | RingRoi | PolygonRoi;
export type PatternParameters = Record<string, ParameterValue>;

export interface PatternModelDef {
  roi: RoiKind;
  validateRoi(roi: unknown): PatternRoi;
  area(roi: PatternRoi): number;
  contains(roi: PatternRoi, x: number, y: number): boolean;
}

/* ---------------------------------------------------------------- parameters */

/** Convert and clamp a parameter value; throws when it is not usable. */
export function coerceParameter(spec: ParameterSpec, value: unknown): ParameterValue {
  if (spec.type === "bool") return typeof value === "string" ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : Boolean(value);
  if (spec.type === "choice") {
    if (typeof value !== "string" || !spec.choices.includes(value)) throw new Error(`${spec.name}: ${String(value)} is not one of ${spec.choices.join(", ")}`);
    return value;
  }
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${spec.name}: ${String(value)} is not a number`);
  const clamped = Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
  return spec.type === "int" ? Math.round(clamped) : clamped;
}

export function defaultParameters(specs: ParameterSpec[]): PatternParameters {
  return Object.fromEntries(specs.map((s) => [s.name, s.default]));
}

/* ---------------------------------------------------------------- ROI helpers */

function finite(roi: unknown, ...names: string[]): number[] {
  const o = (roi ?? {}) as Record<string, unknown>;
  return names.map((n) => {
    const v = o[n];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`ROI field ${n} is missing or not a number`);
    return v;
  });
}

function validateRect(roi: unknown): RectRoi {
  const [a, b, c, d] = finite(roi, "x_start", "x_end", "y_start", "y_end");
  const out = { x_start: Math.min(a, b), x_end: Math.max(a, b), y_start: Math.min(c, d), y_end: Math.max(c, d) };
  if (out.x_end - out.x_start <= 0 || out.y_end - out.y_start <= 0) throw new Error("ROI rectangle has no area");
  return out;
}

function validateRing(roi: unknown): RingRoi {
  const [cx, cy, r1, r2] = finite(roi, "cx", "cy", "r_inner", "r_outer");
  const inner = Math.min(r1, r2);
  const outer = Math.max(r1, r2);
  if (outer <= 0 || outer - inner <= 0) throw new Error("Ring needs two different positive radii");
  return { cx, cy, r_inner: Math.max(0, inner), r_outer: outer };
}

function shoelace(pts: readonly (readonly [number, number])[]): number {
  let s = 0;
  pts.forEach(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  });
  return s / 2;
}

function validatePolygon(roi: unknown): PolygonRoi {
  const raw = (roi as { points?: unknown } | null)?.points;
  if (!Array.isArray(raw)) throw new Error("ROI polygon needs a list of points");
  const pts: [number, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error("ROI polygon point is not an (x, y) pair");
    }
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push([p[0], p[1]]);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3 || shoelace(pts) === 0) throw new Error("ROI polygon has no area");
  return { points: pts };
}

const rectDef = (): PatternModelDef => ({
  roi: "rect",
  validateRoi: validateRect,
  area: (r) => Math.abs((r as RectRoi).x_end - (r as RectRoi).x_start) * Math.abs((r as RectRoi).y_end - (r as RectRoi).y_start),
  contains: (r, x, y) => {
    const q = r as RectRoi;
    return x >= q.x_start && x <= q.x_end && y >= q.y_start && y <= q.y_end;
  },
});

const ringDef: PatternModelDef = {
  roi: "ring",
  validateRoi: validateRing,
  area: (r) => Math.PI * ((r as RingRoi).r_outer ** 2 - (r as RingRoi).r_inner ** 2),
  contains: (r, x, y) => {
    const q = r as RingRoi;
    const d = Math.hypot(x - q.cx, y - q.cy);
    return d >= q.r_inner && d <= q.r_outer;
  },
};

const circleDef: PatternModelDef = {
  roi: "circle",
  validateRoi: (roi) => {
    const [cx, cy, radius] = finite(roi, "cx", "cy", "radius");
    if (radius <= 0) throw new Error("Circle needs a positive radius");
    return { cx, cy, radius };
  },
  area: (r) => Math.PI * (r as CircleRoi).radius ** 2,
  contains: (r, x, y) => {
    const q = r as CircleRoi;
    return Math.hypot(x - q.cx, y - q.cy) <= q.radius;
  },
};

const polygonDef: PatternModelDef = {
  roi: "polygon",
  validateRoi: validatePolygon,
  area: (r) => Math.abs(shoelace((r as PolygonRoi).points)),
  contains: (r, x, y) => {
    const pts = (r as PolygonRoi).points;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
};

/** Data models by the name used in processingPatterns.json. */
export const MODEL_REGISTRY: Record<string, PatternModelDef> = {
  SolidBoxModel: rectDef(),
  OpenBoxModel: rectDef(),
  StairCutModel: rectDef(),
  CleaningLineModel: rectDef(),
  CircleModel: circleDef,
  RingModel: ringDef,
  FreeHandModel: polygonDef,
};

/* ---------------------------------------------------------------- derived geometry (previews) */

/** The ROI split into `steps` equal strips along `direction` (down, up, left, right). */
export function stairRects(roi: RectRoi, params: PatternParameters): RectRoi[] {
  const n = Math.max(1, Math.round(Number(params.steps ?? 5)));
  const direction = String(params.direction ?? "down");
  const out: RectRoi[] = [];
  for (let i = 0; i < n; i++) {
    if (direction === "down" || direction === "up") {
      const h = (roi.y_end - roi.y_start) / n;
      out.push({ ...roi, y_start: roi.y_start + i * h, y_end: roi.y_start + (i + 1) * h });
    } else {
      const w = (roi.x_end - roi.x_start) / n;
      out.push({ ...roi, x_start: roi.x_start + i * w, x_end: roi.x_start + (i + 1) * w });
    }
  }
  return direction === "up" || direction === "left" ? out.reverse() : out;
}

/** A preview with more lines than this is unreadable (and slow to paint); the pattern itself is not limited. */
const MAX_PREVIEW_LINES = 500;

/** Parallel segments across the ROI at `spacing` (at most MAX_PREVIEW_LINES). */
export function cleaningLines(roi: RectRoi, params: PatternParameters): [[number, number], [number, number]][] {
  const spacing = Number(params.spacing ?? 0);
  if (!(spacing > 0)) return [];
  const out: [[number, number], [number, number]][] = [];
  if (params.orientation !== "vertical") {
    for (let y = roi.y_start + spacing / 2; y < roi.y_end && out.length < MAX_PREVIEW_LINES; y += spacing) out.push([[roi.x_start, y], [roi.x_end, y]]);
  } else {
    for (let x = roi.x_start + spacing / 2; x < roi.x_end && out.length < MAX_PREVIEW_LINES; x += spacing) out.push([[x, roi.y_start], [x, roi.y_end]]);
  }
  return out;
}

/* ---------------------------------------------------------------- catalogue from the backend */

export interface ResolvedCatalogue {
  specs: PatternSpec[];
  errors: string[];
}

/** Keep the entries whose model exists here and matches the declared ROI shape; report the rest. */
export function resolveCatalogue(patterns: PatternSpec[], backendErrors: string[] = []): ResolvedCatalogue {
  const specs: PatternSpec[] = [];
  const errors = [...backendErrors];
  for (const p of patterns) {
    const def = MODEL_REGISTRY[p.model];
    if (!def) errors.push(`${p.key}: model ${p.model} is not implemented`);
    else if (def.roi !== p.roi) errors.push(`${p.key}: roi ${p.roi} does not match ${p.model} (${def.roi})`);
    else specs.push(p);
  }
  return { specs, errors };
}
