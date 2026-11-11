import { createSelector, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { WorkflowProgress } from "../lib/processingWorkflows";
import { clearPatternRoi, type ProcessingState } from "./processingSlice";

export type ExposurePhase = "idle" | "preparing" | "running" | "stopping" | "completed" | "stopped" | "error";
export const exposureBusy = (phase: ExposurePhase) => ["preparing", "running", "stopping"].includes(phase);
export type ExposureViewPhase = "idle" | "queued" | "scanning" | "completed" | "stopped" | "error";
export interface ExposureState {
  parallel: boolean;
  phase: ExposurePhase;
  progress: WorkflowProgress[];
  retainedPreview: WorkflowProgress[];
  activeStepIds: string[];
  error: string | null;
  viewPhase: ExposureViewPhase;
  viewError: string | null;
}
const initialState: ExposureState = {
  parallel: false, phase: "idle", progress: [], retainedPreview: [], activeStepIds: [], error: null,
  viewPhase: "idle", viewError: null,
};

type ExposurePreviewState = {exposure: ExposureState; processing: Pick<ProcessingState, "instances">};
export const selectExposurePreview = createSelector(
  [(state: ExposurePreviewState) => state.exposure.progress.length ? state.exposure.progress : state.exposure.retainedPreview,
    (state: ExposurePreviewState) => state.processing.instances],
  (nodes, instances) => nodes.filter(node => instances[node.id.replace(/:\d+:exposure$/, "")]?.roi),
);
const slice = createSlice({ name: "exposure", initialState, reducers: {
  setExposureParallel(s, a: PayloadAction<boolean>) { if (!exposureBusy(s.phase)) s.parallel = a.payload; },
  exposurePreparing(s) {
    s.phase = "preparing"; s.error = null; s.activeStepIds = [];
    s.viewPhase = "idle"; s.viewError = null;
  },
  exposureViewChanged(s, a: PayloadAction<{phase: ExposureViewPhase; error?: string}>) {
    s.viewPhase = a.payload.phase;
    s.viewError = a.payload.error ?? null;
  },
  exposurePrepared(s, a: PayloadAction<WorkflowProgress[]>) {
    s.progress = a.payload; s.retainedPreview = []; s.phase = "running"; s.activeStepIds = [];
  },
  exposureStepStarted: {
    prepare(id: string) { return { payload: { id, at: Date.now() } }; },
    reducer(s, a: PayloadAction<{id: string; at: number}>) {
      for (const n of s.progress) {
        if (n.id === a.payload.id) {
          n.status = "current";
          n.startedAt ??= a.payload.at;
        }
      }
      if (!s.activeStepIds.includes(a.payload.id)) s.activeStepIds.push(a.payload.id);
    },
  },
  exposureSamplesReceived(s, a: PayloadAction<{id: string; count: number}>) {
    const n = s.progress.find(n => n.id === a.payload.id);
    if (n?.exposure) n.exposure.receivedSamples = (n.exposure.receivedSamples ?? 0) + a.payload.count;
  },
  exposureStepCompleted: {
    prepare(id: string) { return { payload: {id, at: Date.now()} }; },
    reducer(s, a: PayloadAction<{id: string; at: number}>) {
      const n = s.progress.find(n => n.id === a.payload.id);
      if (n) { n.status = "completed"; n.finishedAt = a.payload.at; }
      s.activeStepIds = s.activeStepIds.filter(id => id !== a.payload.id);
    },
  },
  exposureStopping(s) { s.phase = "stopping"; },
  exposureFinished: {
    prepare(result: {phase: "completed" | "stopped" | "error"; error?: string}) {
      return {payload: {...result, at: Date.now()}};
    },
    reducer(s, a: PayloadAction<{phase: "completed" | "stopped" | "error"; error?: string; at: number}>) {
      s.phase = a.payload.phase; s.error = a.payload.error ?? null;
      if (s.viewPhase === "queued" || s.viewPhase === "scanning") s.viewPhase = "stopped";
      for (const n of s.progress) if (n.status !== "completed" && n.startedAt !== undefined) {
        n.status = a.payload.phase === "completed" ? "completed" : a.payload.phase;
        n.finishedAt ??= a.payload.at;
      }
      s.activeStepIds = [];
    },
  },
}, extraReducers: builder => {
  builder.addCase(clearPatternRoi, (s, action) => {
    const keep = (node: WorkflowProgress) => node.id.replace(/:\d+:exposure$/, "") !== action.payload;
    s.progress = s.progress.filter(keep);
    s.retainedPreview = s.retainedPreview.filter(keep);
    s.activeStepIds = s.activeStepIds.filter(id => id.replace(/:\d+:exposure$/, "") !== action.payload);
  });
  builder.addMatcher(action => /^processing\/(setPatternParameter|setPatternRoi|undoPatternRoi|setPatternEnabled)$/.test(action.type), s => {
    if (!exposureBusy(s.phase) && s.progress.length) {
      // Recipe edits invalidate its readouts. Keep the executed geometry in world coordinates.
      s.retainedPreview = s.progress;
      s.progress = [];
      s.activeStepIds = [];
    }
  });
} });
export const { setExposureParallel, exposurePreparing, exposurePrepared, exposureStepStarted, exposureSamplesReceived,
  exposureStepCompleted, exposureStopping, exposureFinished, exposureViewChanged } = slice.actions;
export default slice.reducer;
