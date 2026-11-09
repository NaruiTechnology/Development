import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import { DEFAULT_WORKFLOW, type WorkflowSpec, type WorkflowProgress } from "../lib/processingWorkflows";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import {
  MODEL_REGISTRY,
  coerceParameter,
  defaultParameters,
  resolveCatalogue,
  type ParameterValue,
  type PatternParameters,
  type PatternRoi,
  type PatternSpec,
} from "../lib/processingPatterns";

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
}

export interface ProcessingState {
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

const initialState: ProcessingState = { workflows: [DEFAULT_WORKFLOW], materials: [], workflowProgress: [], status: "idle", error: null, entryErrors: [], specs: [], instances: {}, activeKey: null, roiHistory: [] };

interface PatternsResponse {
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
      s.workflowProgress = [];
    },
    setPatternParameter(s, a: PayloadAction<{ key: string; name: string; value: ParameterValue | string }>) {
      const spec = s.specs.find((p) => p.key === a.payload.key)?.parameters.find((q) => q.name === a.payload.name);
      const inst = s.instances[a.payload.key];
      if (!spec || !inst) return;
      try {
        inst.parameters[a.payload.name] = coerceParameter(spec, a.payload.value);
      } catch {
        // not a usable value (e.g. half-typed number): keep the previous one
      }
    },
    setPatternRoi(s, a: PayloadAction<{ key: string; roi: PatternRoi; preview?: boolean }>) {
      const spec = s.specs.find((p) => p.key === a.payload.key);
      const inst = s.instances[a.payload.key];
      if (!spec || !inst) return;
      try {
        const next = MODEL_REGISTRY[spec.model].validateRoi(a.payload.roi);
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
      s.error = null;
    });
    b.addCase(fetchProcessingPatterns.fulfilled, (s, a) => {
      const { specs, errors } = resolveCatalogue(a.payload.patterns ?? [], a.payload.errors ?? []);
      s.status = "ready";
      s.specs = specs;
      s.workflows = [DEFAULT_WORKFLOW, ...(a.payload.workflows ?? []).filter(w => w.name !== "default")];
      s.materials = a.payload.materials ?? [];
      s.entryErrors = errors;
      // keep what the operator already drew when the catalogue is reloaded
      s.instances = Object.fromEntries(specs.map((p) => [p.key, s.instances[p.key] ?? { workflow: "default", workflowEnabled: true, material: "", AvgGray: null, enabled: false, parameters: defaultParameters(p.parameters), roi: null }]));
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

export const { setPatternWorkflow, setPatternMaterial, setWorkflowProgress, updateWorkflowStep, undoPatternRoi, commitPatternRoiEdit, setPatternAvgGray, setPatternEnabled, selectPattern, setPatternParameter, setPatternRoi, clearPatternRoi } = slice.actions;
export default slice.reducer;
