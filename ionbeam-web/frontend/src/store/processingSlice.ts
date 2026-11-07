import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

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
  enabled: boolean;
  parameters: PatternParameters;
  roi: PatternRoi | null;
}

export interface ProcessingState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  entryErrors: string[];
  specs: PatternSpec[];
  instances: Record<string, PatternInstance>;
  /** Pattern being drawn; its card is the only expanded one. */
  activeKey: string | null;
}

const initialState: ProcessingState = { status: "idle", error: null, entryErrors: [], specs: [], instances: {}, activeKey: null };

interface PatternsResponse {
  ok?: boolean;
  error?: string;
  patterns?: PatternSpec[];
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
    selectPattern(s, a: PayloadAction<string | null>) {
      s.activeKey = a.payload !== null && s.instances[a.payload] ? a.payload : null;
    },
    setPatternEnabled(s, a: PayloadAction<{ key: string; enabled: boolean }>) {
      const inst = s.instances[a.payload.key];
      if (inst) inst.enabled = a.payload.enabled;
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
    setPatternRoi(s, a: PayloadAction<{ key: string; roi: PatternRoi }>) {
      const spec = s.specs.find((p) => p.key === a.payload.key);
      const inst = s.instances[a.payload.key];
      if (!spec || !inst) return;
      try {
        inst.roi = MODEL_REGISTRY[spec.model].validateRoi(a.payload.roi);
      } catch {
        // degenerate shape: keep the previous ROI
      }
    },
    clearPatternRoi(s, a: PayloadAction<string>) {
      if (s.instances[a.payload]) s.instances[a.payload].roi = null;
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
      s.entryErrors = errors;
      // keep what the operator already drew when the catalogue is reloaded
      s.instances = Object.fromEntries(specs.map((p) => [p.key, s.instances[p.key] ?? { enabled: false, parameters: defaultParameters(p.parameters), roi: null }]));
      if (s.activeKey && !s.instances[s.activeKey]) s.activeKey = null;
    });
    b.addCase(fetchProcessingPatterns.rejected, (s, a) => {
      s.status = "error";
      s.error = a.error.message ?? "failed to load";
    });
  },
});

export const { setPatternEnabled, selectPattern, setPatternParameter, setPatternRoi, clearPatternRoi } = slice.actions;
export default slice.reducer;
