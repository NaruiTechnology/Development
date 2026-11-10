import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { WorkflowProgress } from "../lib/processingWorkflows";

export type ExposurePhase = "idle" | "preparing" | "running" | "stopping" | "completed" | "stopped" | "error";
export const exposureBusy = (phase: ExposurePhase) => ["preparing", "running", "stopping"].includes(phase);
export interface ExposureState {
  parallel: boolean;
  phase: ExposurePhase;
  progress: WorkflowProgress[];
  activeStepId: string | null;
  error: string | null;
}
const initialState: ExposureState = { parallel: false, phase: "idle", progress: [], activeStepId: null, error: null };
const slice = createSlice({ name: "exposure", initialState, reducers: {
  setExposureParallel(s, a: PayloadAction<boolean>) { if (!exposureBusy(s.phase)) s.parallel = a.payload; },
  exposurePreparing(s) { s.phase = "preparing"; s.error = null; s.progress = []; s.activeStepId = null; },
  exposurePrepared(s, a: PayloadAction<WorkflowProgress[]>) {
    s.progress = a.payload; s.phase = "running"; s.activeStepId = null;
  },
  exposureStepStarted: {
    prepare(id: string) { return { payload: { id, at: Date.now() } }; },
    reducer(s, a: PayloadAction<{id: string; at: number}>) {
      s.activeStepId = a.payload.id;
      for (const n of s.progress) {
        if (n.status === "current") n.status = "upcoming";
        if (n.id === a.payload.id) { n.status = "current"; n.startedAt ??= a.payload.at; }
      }
    },
  },
  exposureSamplesReceived(s, a: PayloadAction<number>) {
    const n = s.progress.find(n => n.id === s.activeStepId);
    if (n?.exposure) n.exposure.receivedSamples = (n.exposure.receivedSamples ?? 0) + a.payload;
  },
  exposureStepCompleted: {
    prepare(id: string) { return { payload: {id, at: Date.now()} }; },
    reducer(s, a: PayloadAction<{id: string; at: number}>) {
      const n = s.progress.find(n => n.id === a.payload.id);
      if (n) { n.status = "completed"; n.finishedAt = a.payload.at; }
    },
  },
  exposureStopping(s) { s.phase = "stopping"; },
  exposureFinished: {
    prepare(result: {phase: "completed" | "stopped" | "error"; error?: string}) {
      return {payload: {...result, at: Date.now()}};
    },
    reducer(s, a: PayloadAction<{phase: "completed" | "stopped" | "error"; error?: string; at: number}>) {
      s.phase = a.payload.phase; s.error = a.payload.error ?? null;
      for (const n of s.progress) if (n.status !== "completed" && n.startedAt !== undefined) {
        n.status = a.payload.phase === "completed" ? "completed" : a.payload.phase;
        n.finishedAt ??= a.payload.at;
      }
      s.activeStepId = null;
    },
  },
}, extraReducers: builder => {
  builder.addMatcher(action => /^processing\/(setPatternParameter|setPatternRoi|clearPatternRoi|undoPatternRoi|setPatternEnabled)$/.test(action.type), s => {
    if (!exposureBusy(s.phase)) { s.progress = []; s.activeStepId = null; }
  });
} });
export const { setExposureParallel, exposurePreparing, exposurePrepared, exposureStepStarted, exposureSamplesReceived,
  exposureStepCompleted, exposureStopping, exposureFinished } = slice.actions;
export default slice.reducer;
