/**
 * Processing tab pattern catalogue (GlasgowDataIO/Json/processingPatterns.json, shared with the native app).
 *
 * Same layout as the deploy workflow's Actions list: `Patterns` is a list of one-key objects, the key is the
 * pattern name. Each entry names its data model (`model`, resolved by the frontend's model registry), the ROI
 * shape the operator draws (`roi`) and a `parameters` schema the card form is generated from.
 *
 * Only structure is checked here. Entries with `skip: true` are dropped, so the browser never instantiates
 * them. A malformed entry is reported in `errors` and does not hide the others; a missing or unparsable file
 * is a ConfigError.
 */
import fs from "node:fs";

import { ConfigError } from "./configManager";

export const ROI_KINDS = ["rect", "circle", "ring", "polygon"] as const;
export const PARAMETER_TYPES = ["int", "float", "bool", "choice"] as const;
export type RoiKind = (typeof ROI_KINDS)[number];
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export interface PatternParameterSpec {
  name: string;
  label: string;
  type: ParameterType;
  default: number | boolean | string;
  min: number | null;
  max: number | null;
  step: number;
  unit: string;
  choices: string[];
}

export interface PatternReadoutSpec {
  name: string;
  label: string;
  source: "elapsed" | "centerX" | "centerY";
  unit: string;
}

export interface PatternSpec {
  key: string;
  model: string;
  caption: string;
  icon: string;
  roi: RoiKind;
  parameters: PatternParameterSpec[];
  readouts?: PatternReadoutSpec[];
}

export interface WorkflowSpec {
  name: string;
  caption: string;
  steps: { caption: string; actions: {
    caption: string; mode: "scan" | "spot";
    selection?: "dark" | "bright"; thresholdMaterial?: string; thresholdSource?: "fullScaleAverage" | "selectedMaterial" | "roiAverage";
  }[] }[];
}

function parseWorkflows(data: Record<string, unknown>): Pick<ProcessingPatternsConfig, "materials" | "workflows"> {
  const materials = (Array.isArray(data.Materials) ? data.Materials : []).map((m: unknown) => {
    if (!isObject(m) || typeof m.name !== "string" || typeof m.brightness !== "number" || !Number.isFinite(m.brightness) || m.brightness <= 0)
      throw new ConfigError("Invalid workflow material brightness", 500);
    return { name: m.name, caption: typeof m.caption === "string" && m.caption ? m.caption : m.name, brightness: m.brightness };
  });
  const names = new Set<string>();
  const workflows = (Array.isArray(data.Workflows) ? data.Workflows : []).map((w: unknown): WorkflowSpec => {
    if (!isObject(w) || typeof w.name !== "string" || names.has(w.name) || (w.steps !== undefined && !Array.isArray(w.steps)))
      throw new ConfigError("Invalid or duplicate processing workflow", 500);
    names.add(w.name);
    return { name: w.name, caption: String(w.caption ?? w.name), steps: (Array.isArray(w.steps) ? w.steps : []).map((s: unknown, index: number) => {
      if (!isObject(s) || !Array.isArray(s.actions) || s.actions.length !== 1)
        throw new ConfigError("Workflow steps require exactly one scan or Spot action", 500);
      return { caption: String(s.caption ?? `Step ${index + 1}`), actions: s.actions.map((a: unknown) => {
        if (!isObject(a) || !["scan", "spot"].includes(String(a.mode)))
          throw new ConfigError("Invalid processing workflow action", 500);
        const thresholdSource = a.thresholdSource;
        const usesFullScaleAverage = thresholdSource === "fullScaleAverage";
        const usesSelectedMaterial = thresholdSource === "selectedMaterial";
        const usesRoiAverage = thresholdSource === "roiAverage";
        const hasKnownThresholdSource = usesFullScaleAverage || usesSelectedMaterial || usesRoiAverage;
        const hasKnownThresholdMaterial = typeof a.thresholdMaterial === "string" && materials.some(m => m.name === a.thresholdMaterial);
        const invalidSpotSource = a.mode === "spot" && (thresholdSource !== undefined
          ? !hasKnownThresholdSource || a.thresholdMaterial !== undefined
          : !hasKnownThresholdMaterial);
        const invalidScanOptions = a.mode === "scan" &&
          (a.selection !== undefined || thresholdSource !== undefined || a.thresholdMaterial !== undefined);
        if ((a.mode === "spot" && !["dark", "bright"].includes(String(a.selection))) || invalidSpotSource || invalidScanOptions)
          throw new ConfigError("Invalid processing workflow action or threshold material", 500);
        return { caption: String(a.caption ?? (a.mode === "spot" ? "Spot" : "Scan")), mode: a.mode as "scan" | "spot",
          ...(a.mode === "spot" ? { selection: a.selection as "dark" | "bright",
            ...(hasKnownThresholdSource ? { thresholdSource: thresholdSource as "fullScaleAverage" | "selectedMaterial" | "roiAverage" } :
              { thresholdMaterial: a.thresholdMaterial as string }) } : {}) };
      }) };
    }) };
  });
  return { materials, workflows };
}

export interface ProcessingPatternsConfig {
  header: Record<string, unknown>;
  patterns: PatternSpec[];
  errors: string[];
  materials: { name: string; caption: string; brightness: number }[];
  workflows: WorkflowSpec[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberOrNull(v: unknown, what: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a finite number`);
  return v;
}

function parseParameters(key: string, raw: unknown): PatternParameterSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!isObject(raw)) throw new Error(`${key}: 'parameters' must be an object`);
  return Object.entries(raw).map(([name, d]) => {
    const where = `${key}.${name}`;
    if (!isObject(d)) throw new Error(`${where}: parameter must be an object`);
    const type = d.type ?? "float";
    if (!(PARAMETER_TYPES as readonly unknown[]).includes(type)) throw new Error(`${where}: unknown type ${JSON.stringify(type)}`);
    const choices = Array.isArray(d.choices) ? d.choices.map(String) : [];
    if (type === "choice" && choices.length === 0) throw new Error(`${where}: choice parameter needs 'choices'`);
    const min = numberOrNull(d.min, `${where}.min`);
    const max = numberOrNull(d.max, `${where}.max`);
    if (min !== null && max !== null && min > max) throw new Error(`${where}: min is above max`);
    const step = numberOrNull(d.step, `${where}.step`) ?? 1;
    let def: number | boolean | string;
    if (type === "bool") def = d.default === true;
    else if (type === "choice") {
      def = String(d.default ?? choices[0]);
      if (!choices.includes(def)) throw new Error(`${where}: default is not one of the choices`);
    } else {
      const n = numberOrNull(d.default ?? 0, `${where}.default`) ?? 0;
      def = Math.min(max ?? n, Math.max(min ?? n, n));
      if (type === "int") def = Math.round(def);
    }
    return {
      name, label: typeof d.label === "string" ? d.label : name, type: type as ParameterType, default: def,
      min, max, step: step > 0 ? step : 1, unit: typeof d.unit === "string" ? d.unit : "", choices,
    };
  });
}

function parseReadouts(key: string, raw: unknown): PatternReadoutSpec[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) throw new Error(`${key}: readouts must be an object`);
  return Object.entries(raw).map(([name, value]) => {
    if (!isObject(value) || !["elapsed", "centerX", "centerY"].includes(String(value.source))) throw new Error(`${key}.${name}: invalid readout source`);
    return { name, label: typeof value.label === "string" ? value.label : name,
      source: value.source as PatternReadoutSpec["source"], unit: typeof value.unit === "string" ? value.unit : "" };
  });
}

export function parseProcessingPatterns(data: unknown): ProcessingPatternsConfig {
  if (!isObject(data) || !Array.isArray(data.Patterns)) {
    throw new ConfigError("processing patterns file needs a top-level 'Patterns' list", 500);
  }
  const out: ProcessingPatternsConfig = { header: isObject(data.Header) ? data.Header : {}, patterns: [], errors: [], ...parseWorkflows(data) };
  const seen = new Set<string>();
  data.Patterns.forEach((entry, i) => {
    try {
      if (!isObject(entry) || Object.keys(entry).length !== 1) {
        throw new Error(`entry ${i}: expected an object with exactly one key (the pattern name)`);
      }
      const [key, body] = Object.entries(entry)[0];
      if (seen.has(key)) throw new Error(`${key}: duplicate pattern name`);
      if (!isObject(body)) throw new Error(`${key}: value must be an object`);
      const roi = body.roi ?? "rect";
      if (!(ROI_KINDS as readonly unknown[]).includes(roi)) throw new Error(`${key}: unknown roi kind ${JSON.stringify(roi)}`);
      if (typeof body.model !== "string" || !body.model) throw new Error(`${key}: missing 'model'`);
      seen.add(key);
      if (body.skip === true) return;                       // skipped: validated for shape only, never sent
      out.patterns.push({
        key, model: body.model, caption: typeof body.caption === "string" ? body.caption : key,
        icon: typeof body.icon === "string" ? body.icon : "", roi: roi as RoiKind,
        parameters: parseParameters(key, body.parameters), readouts: parseReadouts(key, body.readouts),
      });
    } catch (err) {
      out.errors.push(err instanceof Error ? err.message : String(err));
    }
  });
  return out;
}

export function readProcessingPatterns(file: string): ProcessingPatternsConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  try {
    return parseProcessingPatterns(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) throw new ConfigError(`${file} is not valid JSON: ${err.message}`, 500);
    throw err;
  }
}
