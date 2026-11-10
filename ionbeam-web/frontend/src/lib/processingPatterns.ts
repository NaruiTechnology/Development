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

export interface PatternReadoutSpec {
  name: string;
  label: string;
  source: "elapsed" | "spotCount" | "centerX" | "centerY";
  unit: string;
}

export interface PatternSpec {
  key: string;
  model: string;
  caption: string;
  icon: string;
  roi: RoiKind;
  parameters: ParameterSpec[];
  readouts?: PatternReadoutSpec[];
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
      const dx = xj - xi, dy = yj - yi;
      if (Math.abs(dx * (y - yi) - dy * (x - xi)) <= 1e-10 * Math.max(1, Math.hypot(dx, dy))
        && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
};

/** A finite-width line uses a four-corner polygon so every existing mask consumer agrees.
 * Points are start+normal, end+normal, end-normal, start-normal; ends are flat.
 */
export function lineRoi(start: readonly [number, number], end: readonly [number, number], width: number): PolygonRoi {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (![...start, ...end, width].every(Number.isFinite) || length <= 0 || width <= 0) throw new Error("Line needs distinct endpoints and a positive width");
  const nx = -dy / length * width / 2, ny = dx / length * width / 2;
  return { points: [[start[0] + nx, start[1] + ny], [end[0] + nx, end[1] + ny],
    [end[0] - nx, end[1] - ny], [start[0] - nx, start[1] - ny]] };
}

export function lineEndpoints(roi: PolygonRoi): [[number, number], [number, number]] {
  const [a, b, c, d] = roi.points;
  return [[(a[0] + d[0]) / 2, (a[1] + d[1]) / 2], [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]];
}

/** Manual PN 21021-B p. 2-60 specifies four clicks. Reject crossing edges. */
function validateFourPointPolygon(roi: unknown): PolygonRoi {
  const result = validatePolygon(roi);
  if (result.points.length !== 4) throw new Error("Polygon needs four distinct vertices");
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const intersects = (a: number[], b: number[], c: number[], d: number[]) =>
    cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
  const [a, b, c, d] = result.points;
  if (intersects(a, b, c, d) || intersects(b, c, d, a)) throw new Error("Polygon edges must not cross");
  return result;
}

/** Data models by the name used in processingPatterns.json. */
export const MODEL_REGISTRY: Record<string, PatternModelDef> = {
  SolidBoxModel: rectDef(),
  OpenBoxModel: rectDef(),
  StairCutModel: rectDef(),
  CleaningLineModel: rectDef(),
  CircleModel: circleDef,
  RingModel: ringDef,
  FreeHandModel: polygonDef,
  LineModel: { ...polygonDef, validateRoi: validateFourPointPolygon },
  PolygonModel: { ...polygonDef, validateRoi: validateFourPointPolygon },
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

/** World-space extent shared by the ROI chip and editing handles. */
export function patternBounds(roi: PatternRoi): RectRoi {
  if ("x_start" in roi) return roi;
  if ("cx" in roi) {
    const r = "radius" in roi ? roi.radius : roi.r_outer;
    return { x_start: roi.cx - r, x_end: roi.cx + r, y_start: roi.cy - r, y_end: roi.cy + r };
  }
  return { x_start: Math.min(...roi.points.map(p => p[0])), x_end: Math.max(...roi.points.map(p => p[0])),
    y_start: Math.min(...roi.points.map(p => p[1])), y_end: Math.max(...roi.points.map(p => p[1])) };
}

/** Average raw gray of opaque pixel centres inside the actual ROI shape. */
export function* patternAvgGraySteps(roi: PatternRoi, model: (typeof MODEL_REGISTRY)[string], width: number, height: number,
  world: { x_origin: number; x_end: number; y_origin: number; y_end: number },
  sample: (index: number) => number | null): Generator<void, number | null> {
  let sum = 0, count = 0;
  const bounds = patternBounds(roi);
  const range = (a: number, b: number, origin: number, end: number, size: number) => {
    if (origin === end) return [0, 0];
    const p = (a - origin) / (end - origin) * size;
    const q = (b - origin) / (end - origin) * size;
    return [Math.max(0, Math.floor(Math.min(p, q))), Math.min(size, Math.ceil(Math.max(p, q)))];
  };
  const [x0, x1] = range(bounds.x_start, bounds.x_end, world.x_origin, world.x_end, width);
  const [y0, y1] = range(bounds.y_start, bounds.y_end, world.y_origin, world.y_end, height);
  for (let y = y0; y < y1; y++) {
    yield;
    const wy = world.y_origin + (y + 0.5) / height * (world.y_end - world.y_origin);
    for (let x = x0; x < x1; x++) {
      if (x > x0 && (x - x0) % 128 === 0) yield;
      const wx = world.x_origin + (x + 0.5) / width * (world.x_end - world.x_origin);
      if (!model.contains(roi, wx, wy)) continue;
      const gray = sample(y * width + x);
      if (gray !== null) { sum += gray; count++; }
    }
  }
  return count ? sum / count : null;
}

/** Synchronous helper for small measurements and callers without an idle scheduler. */
export function patternAvgGray(...args: Parameters<typeof patternAvgGraySteps>): number | null {
  const steps = patternAvgGraySteps(...args);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}


/** Editable geometry is measured in the same world units as the drawn ROI. */
export function patternGeometryValues(spec: Pick<PatternSpec, "model">, roi: PatternRoi): Record<string, number> {
  if ("r_inner" in roi) return { rInner: roi.r_inner, rOuter: roi.r_outer };
  if ("radius" in roi) return { radius: roi.radius };
  if (spec.model === "LineModel") {
    const [a, b] = lineEndpoints(roi as PolygonRoi);
    const [p, , , q] = (roi as PolygonRoi).points;
    return { length: Math.hypot(b[0] - a[0], b[1] - a[1]), lineWidth: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  }
  const bounds = patternBounds(roi);
  return { width: bounds.x_end - bounds.x_start, height: bounds.y_end - bounds.y_start };
}

export function syncPatternGeometry(spec: PatternSpec, roi: PatternRoi, parameters: PatternParameters): void {
  for (const [name, value] of Object.entries(patternGeometryValues(spec, roi))) {
    if (spec.parameters.some(p => p.name === name)) parameters[name] = value;
  }
}

export function editPatternGeometry(spec: Pick<PatternSpec, "model">, roi: PatternRoi, name: string, value: number): PatternRoi {
  if (!(name in patternGeometryValues(spec, roi))) return roi;
  if (!Number.isFinite(value) || value < 0 || (name !== "rInner" && value === 0)) throw new Error("Dimension must be positive");
  if ("r_inner" in roi) {
    const next = { ...roi, ...(name === "rInner" ? { r_inner: value } : { r_outer: value }) };
    if (next.r_inner >= next.r_outer) throw new Error("Rin must be smaller than Rout");
    return next;
  }
  if ("radius" in roi) return { ...roi, radius: value };
  if (spec.model === "LineModel") {
    const [a, b] = lineEndpoints(roi as PolygonRoi);
    const values = patternGeometryValues(spec, roi), oldLength = values.length;
    const length = name === "length" ? value : oldLength;
    const width = name === "lineWidth" ? value : values.lineWidth;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = (b[0] - a[0]) * length / oldLength / 2, dy = (b[1] - a[1]) * length / oldLength / 2;
    return lineRoi([mx - dx, my - dy], [mx + dx, my + dy], width);
  }
  const b = patternBounds(roi), mx = (b.x_start + b.x_end) / 2, my = (b.y_start + b.y_end) / 2;
  const sx = name === "width" ? value / (b.x_end - b.x_start) : 1;
  const sy = name === "height" ? value / (b.y_end - b.y_start) : 1;
  const point = (x: number, y: number): [number, number] => [mx + (x - mx) * sx, my + (y - my) * sy];
  if ("points" in roi) return { points: roi.points.map(([x,y]) => point(x,y)) };
  const [x_start,y_start] = point(b.x_start,b.y_start), [x_end,y_end] = point(b.x_end,b.y_end);
  return { x_start,y_start,x_end,y_end };
}

export function patternParameterError(spec: ParameterSpec, value: unknown, pattern?: PatternSpec, roi?: PatternRoi | null): string | null {
  if (spec.type !== "int" && spec.type !== "float") return null;
  const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) return "Enter a finite number";
  if (spec.type === "int" && !Number.isInteger(n)) return "Enter a whole number";
  if (spec.min != null && n < spec.min) return `Minimum: ${spec.min}`;
  if (spec.max != null && n > spec.max) return `Maximum: ${spec.max}`;
  if (pattern && roi) {
    try { editPatternGeometry(pattern, roi, spec.name, n); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }
  return null;
}

/** Signed displacement from the full image centre; independent of acquisition ROI and Zoom. */
export function patternCenterOffset(roi: PatternRoi | null, field: {x_origin: number; x_end: number; y_origin: number; y_end: number}): {x:number; y:number} | null {
  if (!roi) return null;
  const b = patternBounds(roi);
  return { x: (b.x_start + b.x_end - field.x_origin - field.x_end) / 2,
    y: (b.y_start + b.y_end - field.y_origin - field.y_end) / 2 };
}

export function formatPatternTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2,"0")}:${String(Math.floor(seconds / 60) % 60).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}


/** RevC3 pixels average dwell+1 ADC conversions at 8 MS/s. */
export function patternDwellTicks(microseconds: unknown, fallback: number): number {
  const us = Number(microseconds);
  return Number.isFinite(us) && us > 0 ? Math.min(65535, Math.max(0, Math.ceil(us / 0.125) - 1)) : fallback;
}
