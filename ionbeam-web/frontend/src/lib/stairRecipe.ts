import type { PatternParameters } from "./processingPatterns.js";

/**
 * Per-step recipe for Stair cut (PN 21021-B p. 2-60: "a series of five boxes to different levels").
 *
 * Every step removes a different layer, so it can need its own material, dwell, overlap and
 * pass count. The card-level parameters (Steps, Depth, Dwell, Overlap, ...) stay the defaults:
 * a step only stores the fields the operator changed (`StairStepOverride`), so editing a
 * card-level value still moves every step that has not been overridden.
 *
 * Beam current is deliberately NOT per step. The app does not program the instrument current
 * (it only feeds the spot-size lookup), so a per-step current would promise a change the
 * hardware does not make between steps.
 */
export interface StairStep {
  /** false skips this step's exposure (its strip then receives one layer fewer). */
  enabled: boolean;
  /** Cumulative target depth after this step, um. */
  depth: number;
  dwell: number;
  overlap: number;
  /** Explicit pass count. Ignored when `removalRate` > 0 (passes are then derived from dose). */
  passes: number;
  /** Free-text material label for this layer (reported, not used in the maths). */
  material: string;
  /** Calibrated removal rate Sr of this layer, um^3/nC. 0 = not calibrated. */
  removalRate: number;
}

export type StairStepOverride = Partial<StairStep>;

export const STAIR_STEP_FIELDS = ["enabled", "depth", "dwell", "overlap", "passes", "material", "removalRate"] as const;
export const MAX_STAIR_STEPS = 50;

export function stairStepCount(params: PatternParameters): number {
  return Math.max(1, Math.min(MAX_STAIR_STEPS, Math.round(Number(params.steps ?? 5))));
}

/** The step a card-level parameter set implies, i.e. today's behaviour (even depth split). */
export function defaultStairStep(params: PatternParameters, index: number): StairStep {
  const n = stairStepCount(params);
  return {
    enabled: true,
    depth: Number(params.depth ?? 1) * (index + 1) / n,
    dwell: Number(params.dwell ?? 1),
    overlap: Number(params.overlap ?? 50),
    passes: Math.max(1, Math.round(Number(params.passes ?? 1))),
    material: "",
    removalRate: 0,
  };
}

/** Defaults merged with the operator's overrides, one entry per step. */
export function resolveStairSteps(params: PatternParameters, overrides?: ReadonlyArray<StairStepOverride | null | undefined>): StairStep[] {
  const n = stairStepCount(params);
  return Array.from({ length: n }, (_, i) => ({ ...defaultStairStep(params, i), ...(overrides?.[i] ?? {}) }));
}

/** Depth this step adds on top of the previous enabled-or-not step (steps nest, so depths accumulate). */
export function stairIncrementUM(steps: ReadonlyArray<StairStep>, index: number): number {
  return steps[index].depth - (index > 0 ? steps[index - 1].depth : 0);
}

/** First problem in the resolved recipe, or null. Messages name the step (1-based). */
export function stairStepsError(steps: ReadonlyArray<StairStep>): string | null {
  for (const [i, s] of steps.entries()) {
    const where = `Stair cut step ${i + 1}`;
    if (!(Number.isFinite(s.depth) && s.depth > 0)) return `${where}: depth must be a positive number of µm.`;
    if (!(Number.isFinite(s.dwell) && s.dwell >= 0.125 && s.dwell <= 8192)) return `${where}: dwell must be 0.125 to 8192 µs.`;
    if (!(Number.isFinite(s.overlap) && s.overlap >= 0 && s.overlap < 100)) return `${where}: overlap must be 0 to below 100 %.`;
    if (!(Number.isInteger(s.passes) && s.passes >= 1 && s.passes <= 10000)) return `${where}: passes must be a whole number from 1 to 10000.`;
    if (!(Number.isFinite(s.removalRate) && s.removalRate >= 0)) return `${where}: removal rate must be 0 (not calibrated) or positive.`;
    if (i > 0 && s.depth < steps[i - 1].depth) return `${where}: depth ${s.depth} µm is shallower than step ${i} (${steps[i - 1].depth} µm); depths accumulate.`;
  }
  if (!steps.some(s => s.enabled)) return "Stair cut: enable at least one step.";
  return null;
}

/** Parameters one step feeds to the exposure planner. Passes derive from dose only with a calibrated Sr. */
export function stairStepParameters(params: PatternParameters, steps: ReadonlyArray<StairStep>, index: number): PatternParameters {
  const s = steps[index];
  const merged: PatternParameters = { ...params, dwell: s.dwell, overlap: s.overlap, passes: s.passes };
  if (s.removalRate > 0) {
    // depth = dose * Sr  =>  dose = depth / Sr, for the layer this step adds.
    merged.targetDose = stairIncrementUM(steps, index) / s.removalRate;
  }
  return merged;
}

/* ------------------------------------------------------------------ import / export */

const HEADER_ALIASES: Record<string, keyof StairStep | "step"> = {
  step: "step", enabled: "enabled", enable: "enabled", depth: "depth", "depth_um": "depth", dwell: "dwell", "dwell_us": "dwell",
  overlap: "overlap", "overlap_pct": "overlap", passes: "passes", material: "material",
  removalrate: "removalRate", "removal_rate": "removalRate", sr: "removalRate",
};

function numberField(value: unknown, label: string, row: number): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (String(value).trim() === "" || !Number.isFinite(n)) throw new Error(`Row ${row}: ${label} "${String(value)}" is not a number.`);
  return n;
}
function boolField(value: unknown): boolean {
  return typeof value === "boolean" ? value : !["0", "false", "no", "off", "n"].includes(String(value).trim().toLowerCase());
}

function toOverride(raw: Record<string, unknown>, row: number): StairStepOverride {
  const out: StairStepOverride = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = HEADER_ALIASES[rawKey.trim().toLowerCase()];
    if (!key) throw new Error(`Row ${row}: unknown column "${rawKey}". Use ${STAIR_STEP_FIELDS.join(", ")}.`);
    if (key === "step" || value === undefined || value === null || String(value).trim() === "") continue;
    if (key === "enabled") out.enabled = boolField(value);
    else if (key === "material") out.material = String(value).trim();
    else if (key === "passes") {
      const n = numberField(value, key, row);
      if (!Number.isInteger(n)) throw new Error(`Row ${row}: passes "${String(value)}" must be a whole number.`);
      out.passes = n;
    } else out[key] = numberField(value, key, row);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { cells.push(cur); cur = ""; }
    else cur += c;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

/** Accepts a JSON array / `{steps:[...]}` or CSV with a header row. Row i is step i+1 (or its `step` column). */
export function parseStairStepsImport(text: string): StairStepOverride[] {
  const body = text.replace(/^\uFEFF/, "").trim();
  if (!body) throw new Error("The file is empty.");
  let rows: Record<string, unknown>[];
  if (body.startsWith("[") || body.startsWith("{")) {
    let json: unknown;
    try { json = JSON.parse(body); } catch { throw new Error("The file is not valid JSON."); }
    const list = Array.isArray(json) ? json : (json as { steps?: unknown }).steps;
    if (!Array.isArray(list) || list.some(r => typeof r !== "object" || r === null || Array.isArray(r))) throw new Error("JSON must be an array of step objects or {\"steps\": [...]}.");
    rows = list as Record<string, unknown>[];
  } else {
    const lines = body.split(/\r?\n/).filter(l => l.trim() !== "");
    if (lines.length < 2) throw new Error("CSV needs a header row and at least one step.");
    const header = splitCsvLine(lines[0]);
    rows = lines.slice(1).map((line, i) => {
      const cells = splitCsvLine(line);
      if (cells.length > header.length) throw new Error(`Row ${i + 1}: ${cells.length} values for ${header.length} columns.`);
      return Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""]));
    });
  }
  if (!rows.length) throw new Error("The file contains no steps.");
  if (rows.length > MAX_STAIR_STEPS) throw new Error(`At most ${MAX_STAIR_STEPS} steps are supported.`);
  const out: StairStepOverride[] = [];
  rows.forEach((raw, i) => {
    const stepNo = raw.step !== undefined && String(raw.step).trim() !== "" ? Math.round(Number(raw.step)) : i + 1;
    if (!(stepNo >= 1 && stepNo <= MAX_STAIR_STEPS)) throw new Error(`Row ${i + 1}: step number "${String(raw.step)}" is out of range.`);
    if (out[stepNo - 1]) throw new Error(`Row ${i + 1}: step ${stepNo} is listed twice.`);
    out[stepNo - 1] = toOverride(raw, i + 1);
  });
  return Array.from(out, o => o ?? {});
}

const csvCell = (v: string | number | boolean) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

/** CSV of the resolved recipe: a starting template the operator can edit and re-import. */
export function stairStepsToCsv(steps: ReadonlyArray<StairStep>): string {
  const head = ["step", ...STAIR_STEP_FIELDS];
  const lines = steps.map((s, i) => [i + 1, ...STAIR_STEP_FIELDS.map(f => s[f])].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
