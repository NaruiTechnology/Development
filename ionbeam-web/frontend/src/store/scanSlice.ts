import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type {
  RasterRequest,
  ScanResult,
  VectorRequest,
} from "../types/api";

export type ScanKind = "raster" | "vector";
export type ScanPhase =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "error";

interface ScanState {
  kind: ScanKind;
  phase: ScanPhase;
  /** Bytes received in the active stream so far. */
  bytesReceived: number;
  chunksReceived: number;
  /** Result of the last blocking POST call (validated). */
  lastResult: ScanResult | null;
  errorMessage: string | null;

  /** Most recent params, kept editable in state. */
  raster: RasterRequest;
  vector: VectorRequest;
}

const defaultRaster: RasterRequest = {
  resolution: 512,
  dwell: 2,
  latency_bytes: 16384,
  frame_blank: false,
  cookie: 123,
  save_csv: false,
  csv_dir: null,
  do_validate: true,
};

const defaultVector: VectorRequest = {
  pattern: "default",
  points: null,
  latency_bytes: 8196,
  output_mode: "SixteenBit",
  cookie: 123,
  pre_process: true,
  save_csv: false,
  csv_dir: null,
  do_validate: true,
};

const initialState: ScanState = {
  kind: "raster",
  phase: "idle",
  bytesReceived: 0,
  chunksReceived: 0,
  lastResult: null,
  errorMessage: null,
  raster: defaultRaster,
  vector: defaultVector,
};

/* -------- blocking REST runs ------------------------------------------- */

export const runRasterValidated = createAsyncThunk<ScanResult, RasterRequest>(
  "scan/runRasterValidated",
  async (req) => {
    const r = await fetch("/api/scan/raster/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`raster run: HTTP ${r.status} ${await r.text()}`);
    return (await r.json()) as ScanResult;
  }
);

export const runVectorValidated = createAsyncThunk<ScanResult, VectorRequest>(
  "scan/runVectorValidated",
  async (req) => {
    const r = await fetch("/api/scan/vector/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) throw new Error(`vector run: HTTP ${r.status} ${await r.text()}`);
    return (await r.json()) as ScanResult;
  }
);

const slice = createSlice({
  name: "scan",
  initialState,
  reducers: {
    setKind(s, a: PayloadAction<ScanKind>) {
      s.kind = a.payload;
    },
    updateRaster(s, a: PayloadAction<Partial<RasterRequest>>) {
      s.raster = { ...s.raster, ...a.payload };
    },
    updateVector(s, a: PayloadAction<Partial<VectorRequest>>) {
      s.vector = { ...s.vector, ...a.payload };
    },
    /** Live-stream lifecycle markers. The actual WS lives in a hook. */
    streamStarted(s) {
      s.phase = "running";
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.errorMessage = null;
    },
    streamProgress(
      s,
      a: PayloadAction<{ bytes: number; chunks: number }>
    ) {
      s.bytesReceived += a.payload.bytes;
      s.chunksReceived += a.payload.chunks;
    },
    streamPaused(s) {
      // Hardware can't actually pause mid-frame, but the UI distinguishes
      // "stream stopped, image preserved" from "stream stopped, image reset".
      if (s.phase === "running") s.phase = "paused";
    },
    streamStopping(s) {
      s.phase = "stopping";
    },
    streamCompleted(
      s,
      a: PayloadAction<{ chunks: number } | undefined>
    ) {
      s.phase = "completed";
      if (a.payload?.chunks !== undefined) s.chunksReceived = a.payload.chunks;
    },
    streamErrored(s, a: PayloadAction<string>) {
      s.phase = "error";
      s.errorMessage = a.payload;
    },
    streamReset(s) {
      s.phase = "idle";
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.errorMessage = null;
    },
  },
  extraReducers: (b) => {
    b.addCase(runRasterValidated.pending, (s) => {
      s.phase = "running";
      s.errorMessage = null;
    });
    b.addCase(runRasterValidated.fulfilled, (s, a) => {
      s.phase = "completed";
      s.lastResult = a.payload;
    });
    b.addCase(runRasterValidated.rejected, (s, a) => {
      s.phase = "error";
      s.errorMessage = a.error.message ?? "raster run failed";
    });
    b.addCase(runVectorValidated.pending, (s) => {
      s.phase = "running";
      s.errorMessage = null;
    });
    b.addCase(runVectorValidated.fulfilled, (s, a) => {
      s.phase = "completed";
      s.lastResult = a.payload;
    });
    b.addCase(runVectorValidated.rejected, (s, a) => {
      s.phase = "error";
      s.errorMessage = a.error.message ?? "vector run failed";
    });
  },
});

export const {
  setKind,
  updateRaster,
  updateVector,
  streamStarted,
  streamProgress,
  streamPaused,
  streamStopping,
  streamCompleted,
  streamErrored,
  streamReset,
} = slice.actions;

export default slice.reducer;
