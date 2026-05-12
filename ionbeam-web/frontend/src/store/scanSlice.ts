import {
  createAsyncThunk,
  createSlice,
  type PayloadAction,
} from "@reduxjs/toolkit";
import type {
  RasterRequest,
  ScanResult,
  ServerDefaults,
  VectorRequest,
  ROIRequest,
} from "../types/api";
import { fetchDefaults } from "./statusSlice";

export type ScanKind = "raster" | "vector" | "roi";
export type ScanPhase =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "error";

export type VectorRenderMode = "native" | "decimated";

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
  roi: ROIState;

  /** How the vector image is rendered onto the canvas. Per-session — not
   *  persisted to localStorage — because the right choice depends on the
   *  current scan, not a long-term preference. */
  vectorRenderMode: VectorRenderMode;
}

export interface ROIState {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  x_scale_length: number;
  y_scale_length: number;
  scale_unit: string;
  show_grid: boolean;
  selection: ROIRequest | null;
  imageName: string;
  imageDataUrl: string | null;
  keep_loaded_bitmap_after_scan: boolean;
}

const defaultRaster: RasterRequest = {
  resolution: 512,
  dwell: 2,
  latency_bytes: 16384,
  frame_blank: false,
  cookie: 123,
  output_mode: "SixteenBit",
  do_validate: true,
};

const defaultVector: VectorRequest = {
  pattern: "default",
  points: null,
  vector_resolution: 2048,
  latency_bytes: 8196,
  output_mode: "SixteenBit",
  cookie: 123,
  pre_process: true,
  do_validate: true,
};

const initialState: ScanState = {
  kind: "roi",
  phase: "idle",
  bytesReceived: 0,
  chunksReceived: 0,
  lastResult: null,
  errorMessage: null,
  raster: defaultRaster,
  vector: defaultVector,
  roi: {
    x_origin: 0,
    x_end: 100,
    y_origin: 0,
    y_end: 100,
    x_scale_length: 100,
    y_scale_length: 100,
    scale_unit: "um",
    show_grid: true,
    selection: null,
    imageName: "No image selected",
    imageDataUrl: null,
    keep_loaded_bitmap_after_scan: true,
  },
  vectorRenderMode: "decimated",
};

function numberDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function outputModeDefault(value: unknown, fallback: VectorRequest["output_mode"] | undefined): VectorRequest["output_mode"] {
  if (value === "EightBit" || value === "SixteenBit") return value;
  return fallback ?? "SixteenBit";
}

function applyServerDefaults(state: ScanState, defaults: ServerDefaults): void {
  // Prefer the normalized snake_case `raster_params` / `vector_params`
  // blocks if the server sent them — they map 1:1 to the request shapes
  // and don't need any field-name translation. Fall back to the legacy
  // camelCase `raster` / `vector` blocks for older servers.
  const rasterParams = (defaults.raster_params ?? {}) as Record<string, unknown>;
  const vectorParams = (defaults.vector_params ?? {}) as Record<string, unknown>;
  const raster = defaults.raster ?? {};
  const vector = defaults.vector ?? {};

  // Raster: prefer normalized, then legacy `raster` block with the old
  // translation rules (frameBlank → frame_blank, pixels*2 → latency_bytes).
  const rasterLatency =
    rasterParams.latency_bytes ??
    raster.latency_bytes ??
    raster.latency ??
    (raster.pixels !== undefined ? numberDefault(raster.pixels, 8192) * 2 : undefined);

  state.raster = {
    ...state.raster,
    resolution: numberDefault(
      rasterParams.resolution ?? raster.resolution,
      state.raster.resolution
    ),
    dwell: numberDefault(
      rasterParams.dwell ?? raster.dwell,
      state.raster.dwell
    ),
    latency_bytes: numberDefault(rasterLatency, state.raster.latency_bytes),
    frame_blank: Boolean(
      rasterParams.frame_blank ??
        raster.frame_blank ??
        raster.frameBlank ??
        state.raster.frame_blank
    ),
    output_mode: outputModeDefault(
      rasterParams.output_mode ?? raster.output_mode ?? raster.outputMode,
      state.raster.output_mode ?? "SixteenBit"
    ),
  };

  state.vector = {
    ...state.vector,
    latency_bytes: numberDefault(
      vectorParams.latency_bytes ?? vector.latency_bytes ?? vector.latency,
      state.vector.latency_bytes
    ),
    output_mode: outputModeDefault(
      vectorParams.output_mode ?? vector.output_mode ?? vector.outputMode,
      state.vector.output_mode
    ),
  };
}

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
    updateROI(s, a: PayloadAction<Partial<ROIState>>) {
      s.roi = { ...s.roi, ...a.payload };
      if ("selection" in a.payload) {
        s.raster.roi = a.payload.selection ?? null;
        s.vector.roi = a.payload.selection ?? null;
      }
    },
    clearROIImage(s) {
      s.roi.imageName = "No image selected";
      s.roi.imageDataUrl = null;
    },
    clearROISelection(s) {
      s.roi.selection = null;
      s.raster.roi = null;
      s.vector.roi = null;
    },
    setVectorRenderMode(s, a: PayloadAction<VectorRenderMode>) {
      s.vectorRenderMode = a.payload;
    },
    /** Live-stream lifecycle markers. The actual WS lives in a hook. */
    streamStarted(s) {
      s.phase = "running";
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.lastResult = null;
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
      // Pause is dispatched by the WS onclose handler. By that point
      // streamStopping has already moved phase to "stopping" — the
      // previous "phase === 'running'" guard rejected this case and left
      // the UI stuck on "stopping" forever.
      //
      // Hardware can't actually pause mid-frame. Pause is a UI concept
      // meaning "the stream is closed but the partial frame is kept on
      // the canvas". Accept transitions only from the active states; if
      // a "done" or "error" already landed we shouldn't downgrade them.
      if (s.phase === "running" || s.phase === "stopping") {
        s.phase = "paused";
      }
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
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.lastResult = null;
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
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.lastResult = null;
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
    b.addCase(fetchDefaults.fulfilled, (s, a) => {
      applyServerDefaults(s, a.payload);
    });
  },
});

export const {
  setKind,
  updateRaster,
  updateVector,
  updateROI,
  clearROIImage,
  clearROISelection,
  setVectorRenderMode,
  streamStarted,
  streamProgress,
  streamPaused,
  streamStopping,
  streamCompleted,
  streamErrored,
  streamReset,
} = slice.actions;

export default slice.reducer;
