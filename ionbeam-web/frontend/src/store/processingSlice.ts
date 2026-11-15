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
import { MAX_STAIR_STEPS, STAIR_STEP_FIELDS, type StairRecipeCollection, type StairStepOverride } from "../lib/stairRecipe";

/** Independently editable ROI instance of a catalogue pattern type. */
export interface PatternInstance {
  /** Catalogue key shared by instances of the same pattern type. */
  typeKey: string;
  /** Stable, 1-based creation index within this pattern type. */
  index: number;
  workflow: string;
  workflowEnabled: boolean;
  /** Selected entry in the Materials catalogue, used for image guidance and Sr readouts. */
  material: string;
  AvgGray: number | null;
  enabled: boolean;
  parameters: PatternParameters;
  roi: PatternRoi | null;
  /** Stair cut only: sparse per-step overrides of the card-level parameters (index = step - 1). */
  stairSteps?: StairStepOverride[];
  /** Selected named recipe node; defaults to the first configured SMProcess node. */
  stairRecipeNode?: string;
}

export interface ProcessingState {
  lensLookup: LensLookup | null;
  workflows: WorkflowSpec[];
  materials: { name: string; caption?: string; brightness: number; grayValueRange?: [number, number] | null;
    removalRateUM3PerNC?: number; removalRateSource?: string }[];
  stairReceipes: Record<string, StairRecipeCollection>;
  workflowProgress: WorkflowProgress[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  entryErrors: string[];
  specs: PatternSpec[];
  instances: Record<string, PatternInstance>;
  /** Pattern being drawn; its card is the only expanded one. */
  activeKey: string | null;
  /** Order in which pattern ROIs were first committed; exposure follows this order. */
  roiCreationOrder: string[];
  roiHistory: Array<{ key: string; roi: PatternRoi | null; orderIndex: number; createdInstance?: boolean;
    removedInstance?: PatternInstance; removedSpec?: PatternSpec; specIndex?: number }>;
}

const initialState: ProcessingState = { lensLookup: null, workflows: [DEFAULT_WORKFLOW], materials: [], stairReceipes: {}, workflowProgress: [], status: "idle", error: null, entryErrors: [], specs: [], instances: {}, activeKey: null, roiCreationOrder: [], roiHistory: [] };

interface PatternsResponse {
  lensLookup?: unknown;
  ok?: boolean;
  error?: string;
  patterns?: PatternSpec[];
  workflows?: WorkflowSpec[];
  materials?: { name: string; caption?: string; brightness: number; grayValueRange?: [number, number] | null;
    removalRateUM3PerNC?: number; removalRateSource?: string }[];
  stairReceipes?: Record<string, StairRecipeCollection>;
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
            s.roiHistory.push({ key: a.payload.key, roi: previous, orderIndex: s.roiCreationOrder.indexOf(a.payload.key) });
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
      if (field === "material" && row.material !== value) delete row.removalRate;
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
    setStairRecipeNode(s, a: PayloadAction<{ key: string; nodeName: string }>) {
      const inst = s.instances[a.payload.key];
      const spec = s.specs.find(p => p.key === a.payload.key);
      const node = s.stairReceipes.SMProcess?.nodes.find(item => item.name === a.payload.nodeName);
      if (!inst || spec?.model !== "StairCutModel" || !node || node.steps.length > MAX_STAIR_STEPS) return;
      inst.stairRecipeNode = node.name;
      inst.parameters.steps = Math.max(2, node.steps.length);
      inst.stairSteps = node.steps.map(step => ({ enabled: step.enabled, depth: step.depthUM, material: step.material,
        removalRate: step.removalRateUM3PerNC, dwell: step.dwellUS, overlap: step.overlapPercent,
        passes: step.passes, after: step.after }));
      s.workflowProgress = [];
    },
    /** Drawing creates another instance; geometry edits continue to use setPatternRoi. */
    createPatternRoi(s, a: PayloadAction<{ key: string; roi: PatternRoi }>) {
      const source = s.instances[a.payload.key];
      const sourceSpec = s.specs.find(spec => spec.key === a.payload.key);
      if (!source || !sourceSpec) return;
      let roi: PatternRoi;
      try {
        roi = MODEL_REGISTRY[sourceSpec.model].validateRoi(a.payload.roi);
        if (sourceSpec.model === "LineModel") roi = lineRoi(...lineEndpoints(roi as PolygonRoi), Number(source.parameters.lineWidth ?? 0.5));
      } catch { return; }
      const typeKey = source.typeKey ?? sourceSpec.key;
      let key = sourceSpec.key;
      const createdInstance = source.roi !== null;
      if (createdInstance) {
        let index = Math.max(...Object.values(s.instances).filter(inst => inst.typeKey === typeKey).map(inst => inst.index), 1) + 1;
        while (s.instances[`${typeKey}~${index}`]) index++;
        key = `${typeKey}~${index}`;
        s.specs.push({...sourceSpec, key});
        s.instances[key] = {...source, typeKey, index, parameters: {...source.parameters}, roi: null,
          AvgGray: null, stairSteps: source.stairSteps?.map(row => ({...row}))};
      }
      const instance = s.instances[key];
      s.roiHistory.push({key, roi: null, orderIndex: -1, createdInstance});
      if (s.roiHistory.length > 100) s.roiHistory.shift();
      instance.roi = roi;
      instance.enabled = true;
      instance.AvgGray = null;
      syncPatternGeometry(sourceSpec, roi, instance.parameters);
      if (!s.roiCreationOrder.includes(key)) s.roiCreationOrder.push(key);
      s.activeKey = key;
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
          s.roiHistory.push({ key: a.payload.key, roi: inst.roi, orderIndex: s.roiCreationOrder.indexOf(a.payload.key) });
          if (s.roiHistory.length > 100) s.roiHistory.shift();
          if (!inst.roi && !s.roiCreationOrder.includes(a.payload.key)) s.roiCreationOrder.push(a.payload.key);
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
      s.roiHistory.push({ key: a.payload.key, roi: a.payload.original, orderIndex: s.roiCreationOrder.indexOf(a.payload.key) });
      if (s.roiHistory.length > 100) s.roiHistory.shift();
    },
    undoPatternRoi(s) {
      const previous = s.roiHistory.pop();
      if (!previous) return;
      if (previous.removedInstance && previous.removedSpec) {
        s.instances[previous.key] = previous.removedInstance;
        s.specs.splice(Math.min(previous.specIndex ?? s.specs.length, s.specs.length), 0, previous.removedSpec);
        const index = previous.orderIndex >= 0 ? Math.min(previous.orderIndex, s.roiCreationOrder.length) : s.roiCreationOrder.length;
        s.roiCreationOrder.splice(index, 0, previous.key);
        s.activeKey = previous.key;
        s.workflowProgress = [];
        return;
      }
      if (!s.instances[previous.key]) return;
      if (previous.createdInstance) {
        const typeKey = s.instances[previous.key].typeKey;
        delete s.instances[previous.key];
        s.specs = s.specs.filter(spec => spec.key !== previous.key);
        s.roiCreationOrder = s.roiCreationOrder.filter(key => key !== previous.key);
        s.activeKey = [...s.specs].reverse().find(spec => s.instances[spec.key]?.typeKey === typeKey)?.key ?? null;
        s.workflowProgress = [];
        return;
      }
      s.instances[previous.key].roi = previous.roi;
      s.roiCreationOrder = s.roiCreationOrder.filter(key => key !== previous.key);
      if (previous.roi) {
        const index = previous.orderIndex >= 0 ? Math.min(previous.orderIndex, s.roiCreationOrder.length) : s.roiCreationOrder.length;
        s.roiCreationOrder.splice(index, 0, previous.key);
      }
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
        const orderIndex = s.roiCreationOrder.indexOf(a.payload);
        const specIndex = s.specs.findIndex(item => item.key === a.payload);
        const spec = s.specs[specIndex];
        const hasSiblingRoi = s.specs.some(item => item.key !== a.payload
          && s.instances[item.key]?.typeKey === inst.typeKey
          && s.instances[item.key]?.roi);
        const removeInstance = inst.index > 1 || hasSiblingRoi;
        s.roiHistory.push(removeInstance && spec
          ? { key: a.payload, roi: inst.roi, orderIndex, removedInstance: { ...inst }, removedSpec: { ...spec }, specIndex }
          : { key: a.payload, roi: inst.roi, orderIndex });
        if (s.roiHistory.length > 100) s.roiHistory.shift();
        s.roiCreationOrder = s.roiCreationOrder.filter(key => key !== a.payload);
        if (removeInstance) {
          delete s.instances[a.payload];
          s.specs = s.specs.filter(item => item.key !== a.payload);
        } else {
          inst.roi = null;
          inst.AvgGray = null;
          inst.enabled = false;
        }
        s.workflowProgress = [];
        if (s.activeKey === a.payload) {
          const typeKey = inst.typeKey;
          const siblings = s.specs.filter(spec => spec.key !== a.payload
            && s.instances[spec.key]?.typeKey === typeKey);
          const remaining = siblings.find(spec => s.instances[spec.key]?.roi) ?? siblings[0];
          s.activeKey = remaining?.key ?? null;
        }
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
      // Rebuild runtime specs from the catalogue while retaining every ROI instance.
      const previousInstances = s.instances;
      const runtimeSpecs = specs.flatMap(spec => [spec, ...Object.entries(previousInstances)
        .filter(([key, instance]) => key !== spec.key && instance.typeKey === spec.key)
        .sort(([, a], [, b]) => a.index - b.index)
        .map(([key]) => ({...spec, key}))]);
      s.specs = runtimeSpecs;
      s.workflows = [DEFAULT_WORKFLOW, ...(a.payload.workflows ?? []).filter(w => w.name !== "default")];
      s.materials = a.payload.materials ?? [];
      s.stairReceipes = a.payload.stairReceipes ?? {};
      s.entryErrors = errors;
      // keep what the operator already drew when the catalogue is reloaded
      s.instances = Object.fromEntries(runtimeSpecs.map(p => {
        const previous = previousInstances[p.key];
        return [p.key, previous ? {...previous, typeKey: previous.typeKey ?? p.key, index: previous.index ?? 1,
          parameters: {...defaultParameters(p.parameters), ...previous.parameters}}
          : {typeKey: p.key, index: 1, workflow: "default", workflowEnabled: true, material: "", AvgGray: null,
            enabled: false, parameters: defaultParameters(p.parameters), roi: null}];
      }));
      s.roiCreationOrder = s.roiCreationOrder.filter(key => Boolean(s.instances[key]?.roi));
      for (const spec of runtimeSpecs) if (s.instances[spec.key]?.roi && !s.roiCreationOrder.includes(spec.key)) s.roiCreationOrder.push(spec.key);
      for (const spec of runtimeSpecs) {
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

export const { setPatternWorkflow, setPatternMaterial, setWorkflowProgress, updateWorkflowStep, undoPatternRoi, commitPatternRoiEdit, setPatternAvgGray, setPatternEnabled, selectPattern, setPatternParameter, setStairStepField, setStairSteps, setStairRecipeNode, createPatternRoi, setPatternRoi, clearPatternRoi } = slice.actions;
export default slice.reducer;
