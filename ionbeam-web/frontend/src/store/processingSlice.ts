import { parseLensLookup, type LensLookup } from "../lib/lensLookup";
import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import { DEFAULT_WORKFLOW, type WorkflowSpec, type WorkflowProgress } from "../lib/processingWorkflows";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import {
  MODEL_REGISTRY,
  editPatternGeometry,
  syncPatternGeometry,
  patternParameterError,
  lineEndpoints,
  lineRoi,
  type PolygonRoi,
  coerceParameter,
  defaultParameters,
  resolveCatalogue,
  type ParameterValue,
  type PatternParameters,
  type PatternRoi,
  type PatternSpec,
} from "../lib/processingPatterns";
import { MAX_STAIR_STEPS, STAIR_STEP_FIELDS, type StairStepOverride } from "../lib/stairRecipe";

/** One live instance per catalogue entry: the parameter values and the ROI the operator drew. */
export interface PatternInstance {
  workflow: string;
  workflowEnabled: boolean;
  /** Selected entry in the Materials catalogue for MaterialLinelCut. */
  material: string;
  AvgGray: number | null;
  enabled: boolean;
  parameters: PatternParameters;
  roi: PatternRoi | null;
  /** Stair cut only: sparse per-step overrides of the card-level parameters (index = step - 1). */
  stairSteps?: StairStepOverride[];
}

export interface ProcessingState {
  lensLookup: LensLookup | null;
  workflows: WorkflowSpec[];
  materials: { name: string; caption?: string; brightness: number }[];
  workflowProgress: WorkflowProgress[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  entryErrors: string[];
  specs: PatternSpec[];
  instances: Record<string, PatternInstance>;
  /** Pattern being drawn; its card is the only expanded one. */
  activeKey: string | null;
  roiHistory: Array<{ key: string; roi: PatternRoi | null }>;
}

const initialState: ProcessingState = { lensLookup: null, workflows: [DEFAULT_WORKFLOW], materials: [], workflowProgress: [], status: "idle", error: null, entryErrors: [], specs: [], instances: {}, activeKey: null, roiHistory: [] };

interface PatternsResponse {
  lensLookup?: unknown;
  ok?: boolean;
  error?: string;
  patterns?: PatternSpec[];
  workflows?: WorkflowSpec[];
  materials?: { name: string; caption?: string; brightness: number }[];
  errors?: string[];
}

export const fetchProcessingPatterns = createAsyncThunk<PatternsResponse>("processing/fetch", async () => {
  const response = await fetch(apiUrl("/api/processing/patterns"));
  const data = await readJsonResponse<PatternsResponse>(response, "processing patterns");
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `processing patterns: HTTP ${response.status}`);
  return data;
});

const slice = createSlice({
  name: "processing",
  initialState,
  reducers: {
    setPatternWorkflow(s, a: PayloadAction<{ key: string; workflow?: string; enabled?: boolean }>) {
      const inst = s.instances[a.payload.key];
      if (!inst) return;
      if (a.payload.workflow && s.workflows.some(w => w.name === a.payload.workflow)) inst.workflow = a.payload.workflow;
      if (a.payload.enabled !== undefined) inst.workflowEnabled = a.payload.enabled;
      s.workflowProgress = [];
    },
    setPatternMaterial(s, a: PayloadAction<{ key: string; material: string }>) {
      const inst = s.instances[a.payload.key];
      if (inst && s.materials.some(m => m.name === a.payload.material)) inst.material = a.payload.material;
    },
    setWorkflowProgress: {
      prepare(steps: WorkflowProgress[]) {
        const at = Date.now();
        return { payload: steps.map(step => step.status === "current" ? { ...step, startedAt: step.startedAt ?? at } : step) };
      },
      reducer(s, a: PayloadAction<WorkflowProgress[]>) { s.workflowProgress = a.payload; },
    },
    updateWorkflowStep: {
      prepare(payload: { id?: string; status: WorkflowProgress["status"] }) {
        return { payload: { ...payload, at: Date.now() } };
      },
      reducer(s, a: PayloadAction<{ id?: string; status: WorkflowProgress["status"]; at: number }>) {
        for (const step of s.workflowProgress) {
          if (!(a.payload.id ? step.id === a.payload.id : step.status === "current")) continue;
          if (a.payload.status === "current" && step.status !== "current") {
            step.startedAt = a.payload.at;
            delete step.finishedAt;
          } else if (["completed", "stopped", "error"].includes(a.payload.status) && step.startedAt !== undefined && step.finishedAt === undefined) {
            step.finishedAt = a.payload.at;
          }
          step.status = a.payload.status;
        }
      },
    },
    selectPattern(s, a: PayloadAction<string | null>) {
      s.activeKey = a.payload !== null && s.instances[a.payload] ? a.payload : null;
    },
    setPatternEnabled(s, a: PayloadAction<{ key: string; enabled: boolean }>) {
      const inst = s.instances[a.payload.key];
      if (inst) inst.enabled = a.payload.enabled && inst.roi !== null;
      if (!a.payload.enabled && s.activeKey === a.payload.key) {
        const currentIndex = s.specs.findIndex(spec => spec.key === a.payload.key);
        const remaining = s.specs.slice(currentIndex + 1).concat(s.specs.slice(0, currentIndex))
          .find(spec => spec.key !== a.payload.key && s.instances[spec.key]?.enabled && s.instances[spec.key]?.roi);
        s.activeKey = remaining?.key ?? null;
      }
      s.workflowProgress = [];
    },
    setPatternParameter(s, a: PayloadAction<{ key: string; name: string; value: ParameterValue | string }>) {
      const pattern = s.specs.find(p => p.key === a.payload.key);
      const spec = pattern?.parameters.find(q => q.name === a.payload.name);
      const inst = s.instances[a.payload.key];
      if (!pattern || !spec || !inst || patternParameterError(spec, a.payload.value, pattern, inst.roi)) return;
      try {
        const value = coerceParameter(spec, a.payload.value);
        if (inst.roi && typeof value === "number") {
          const previous = inst.roi;
          const next = editPatternGeometry(pattern, previous, spec.name, value);
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            s.roiHistory.push({ key: a.payload.key, roi: previous });
            if (s.roiHistory.length > 100) s.roiHistory.shift();
            inst.roi = MODEL_REGISTRY[pattern.model].validateRoi(next);
            inst.AvgGray = null;
            syncPatternGeometry(pattern, inst.roi, inst.parameters);
          }
        }
        inst.parameters[spec.name] = value;
        s.workflowProgress = [];
      } catch { /* keep the last valid parameter and geometry */ }
    },
    /** Override one field of one Stair cut step; `value: undefined` returns that field to the card-level default. */
    setStairStepField(s, a: PayloadAction<{ key: string; index: number; field: typeof STAIR_STEP_FIELDS[number]; value: number | string | boolean | undefined }>) {
      const { key, index, field, value } = a.payload;
      const inst = s.instances[key];
      const spec = s.specs.find(p => p.key === key);
      if (!inst || spec?.model !== "StairCutModel" || !Number.isInteger(index) || index < 0 || index >= MAX_STAIR_STEPS || !STAIR_STEP_FIELDS.includes(field)) return;
      const rows = inst.stairSteps ?? [];
      while (rows.length <= index) rows.push({});
      const row: Record<string, unknown> = { ...rows[index] };
      if (value === undefined) delete row[field]; else row[field] = value;
      rows[index] = row as StairStepOverride;
      inst.stairSteps = rows;
      s.workflowProgress = [];
    },
    /** Replace all per-step overrides (file import) or clear them (`steps: null`). */
    setStairSteps(s, a: PayloadAction<{ key: string; steps: StairStepOverride[] | null }>) {
      const inst = s.instances[a.payload.key];
      const spec = s.specs.find(p => p.key === a.payload.key);
      if (!inst || spec?.model !== "StairCutModel") return;
      const steps = a.payload.steps;
      if (steps && steps.length > MAX_STAIR_STEPS) return;
      if (steps) inst.parameters.steps = Math.max(2, steps.length);
      if (steps) inst.stairSteps = steps; else delete inst.stairSteps;
      s.workflowProgress = [];
    },
    setPatternRoi(s, a: PayloadAction<{ key: string; roi: PatternRoi; preview?: boolean }>) {
      const spec = s.specs.find((p) => p.key === a.payload.key);
      const inst = s.instances[a.payload.key];
      if (!spec || !inst) return;
      try {
        let next = MODEL_REGISTRY[spec.model].validateRoi(a.payload.roi);
        if (spec.model === "LineModel") next = lineRoi(...lineEndpoints(next as PolygonRoi), Number(inst.parameters.lineWidth ?? 0.5));
        if (!a.payload.preview && !inst.enabled) {
          inst.enabled = true;
          s.workflowProgress = [];
        }
        if (JSON.stringify(inst.roi) === JSON.stringify(next)) return;
        if (!a.payload.preview) {
          s.roiHistory.push({ key: a.payload.key, roi: inst.roi });
          if (s.roiHistory.length > 100) s.roiHistory.shift();
        }
        inst.roi = next;
        syncPatternGeometry(spec, next, inst.parameters);
        s.workflowProgress = [];
      } catch {
        // degenerate shape: keep the previous ROI
      }
    },
    commitPatternRoiEdit(s, a: PayloadAction<{ key: string; original: PatternRoi }>) {
      const inst = s.instances[a.payload.key];
      if (!inst || JSON.stringify(inst.roi) === JSON.stringify(a.payload.original)) return;
      s.roiHistory.push({ key: a.payload.key, roi: a.payload.original });
      if (s.roiHistory.length > 100) s.roiHistory.shift();
    },
    undoPatternRoi(s) {
      const previous = s.roiHistory.pop();
      if (!previous || !s.instances[previous.key]) return;
      s.instances[previous.key].roi = previous.roi;
      const spec = s.specs.find(p => p.key === previous.key);
      if (previous.roi && spec) syncPatternGeometry(spec, previous.roi, s.instances[previous.key].parameters);
      if (!previous.roi) s.instances[previous.key].enabled = false;
      s.instances[previous.key].AvgGray = null;
      s.activeKey = previous.key;
    },
    setPatternAvgGray(s, a: PayloadAction<Record<string, number | null>>) {
      for (const [key, value] of Object.entries(a.payload)) {
        if (s.instances[key]) s.instances[key].AvgGray = value;
      }
    },
    clearPatternRoi(s, a: PayloadAction<string>) {
      const inst = s.instances[a.payload];
      if (inst?.roi) {
        s.roiHistory.push({ key: a.payload, roi: inst.roi });
        if (s.roiHistory.length > 100) s.roiHistory.shift();
        inst.roi = null;
        inst.AvgGray = null;
        inst.enabled = false;
        s.workflowProgress = [];
      }
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchProcessingPatterns.pending, (s) => {
      s.status = "loading";
      s.lensLookup = null;
      s.error = null;
    });
    b.addCase(fetchProcessingPatterns.fulfilled, (s, a) => {
      const { specs, errors } = resolveCatalogue(a.payload.patterns ?? [], a.payload.errors ?? []);
      s.status = "ready";
      s.lensLookup = null;
      if (a.payload.lensLookup != null) {
        try { s.lensLookup = parseLensLookup(a.payload.lensLookup); }
        catch (e) { errors.push(`LensLookup: ${e instanceof Error ? e.message : String(e)}`); }
      }
      s.specs = specs;
      s.workflows = [DEFAULT_WORKFLOW, ...(a.payload.workflows ?? []).filter(w => w.name !== "default")];
      s.materials = a.payload.materials ?? [];
      s.entryErrors = errors;
      // keep what the operator already drew when the catalogue is reloaded
      s.instances = Object.fromEntries(specs.map((p) => [p.key, s.instances[p.key] ? { ...s.instances[p.key], parameters: { ...defaultParameters(p.parameters), ...s.instances[p.key].parameters } } : { workflow: "default", workflowEnabled: true, material: "", AvgGray: null, enabled: false, parameters: defaultParameters(p.parameters), roi: null }]));
      for (const spec of specs) {
        const inst = s.instances[spec.key];
        if (inst.roi) syncPatternGeometry(spec, inst.roi, inst.parameters);
      }
      for (const inst of Object.values(s.instances)) {
        if (!inst.roi) inst.enabled = false;
        if (!s.materials.some(m => m.name === inst.material)) inst.material = s.materials[0]?.name ?? "";
      }
      s.roiHistory = s.roiHistory.filter(entry => Boolean(s.instances[entry.key]));
      if (s.activeKey && !s.instances[s.activeKey]) s.activeKey = null;
    });
    b.addCase(fetchProcessingPatterns.rejected, (s, a) => {
      s.status = "error";
      s.error = a.error.message ?? "failed to load";
    });
  },
});

export const { setPatternWorkflow, setPatternMaterial, setWorkflowProgress, updateWorkflowStep, undoPatternRoi, commitPatternRoiEdit, setPatternAvgGray, setPatternEnabled, selectPattern, setPatternParameter, setStairStepField, setStairSteps, setPatternRoi, clearPatternRoi } = slice.actions;
export default slice.reducer;
