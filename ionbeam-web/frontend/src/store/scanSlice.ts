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
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";

export type ScanKind = "raster" | "vector" | "roi" | "mag";
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
  /** Latest scan output filenames, regardless of validated vs streamed run. */
  lastOutput: {
    kind: "raster" | "vector";
    csv_filename: string | null;
    image_filename: string | null;
  } | null;
  errorMessage: string | null;

  /** Most recent params, kept editable in state. */
  raster: RasterRequest;
  vector: VectorRequest;
  roi: ROIState;
  /** Manual beam energy entry shared by the raster/vector panels. */
  beamEnergyEv: number;

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
  viewport_x_start: number;
  viewport_x_end: number;
  viewport_y_start: number;
  viewport_y_end: number;
  calibration_enabled: boolean;
  calibration_x_origin: number;
  calibration_x_end: number;
  calibration_y_origin: number;
  calibration_y_end: number;
  calibration_viewport_x_start: number;
  calibration_viewport_x_end: number;
  calibration_viewport_y_start: number;
  calibration_viewport_y_end: number;
  calibration_confirmed: boolean;
  x_scale_length: number;
  y_scale_length: number;
  scale_unit: string;
  show_grid: boolean;
  selection: ROIRequest | null;
  imageName: string;
  imageDataUrl: string | null;
  imageKind: "none" | "file" | "lastScan";
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
  dwell: 1,
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
  lastOutput: null,
  errorMessage: null,
  raster: defaultRaster,
  vector: defaultVector,
  roi: {
    x_origin: 0,
    x_end: 100,
    y_origin: 0,
    y_end: 100,
    viewport_x_start: 0,
    viewport_x_end: 640,
    viewport_y_start: 0,
    viewport_y_end: 640,
    calibration_enabled: false,
    calibration_x_origin: 0,
    calibration_x_end: 100,
    calibration_y_origin: 0,
    calibration_y_end: 100,
    calibration_viewport_x_start: 0,
    calibration_viewport_x_end: 640,
    calibration_viewport_y_start: 0,
    calibration_viewport_y_end: 640,
    calibration_confirmed: false,
    x_scale_length: 100,
    y_scale_length: 100,
    scale_unit: "um",
    show_grid: true,
    selection: null,
    imageName: "No image selected",
    imageDataUrl: null,
    imageKind: "none",
    keep_loaded_bitmap_after_scan: true,
  },
  beamEnergyEv: 1000.0,
  vectorRenderMode: "decimated",
};

function numberDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function floatDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function booleanDefault(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
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
    frame_blank: booleanDefault(
      rasterParams.frame_blank ??
        raster.frame_blank ??
        raster.frameBlank,
      state.raster.frame_blank
    ),
    do_validate: booleanDefault(
      rasterParams.do_validate ??
        raster.do_validate ??
        raster.doValidate,
      state.raster.do_validate
    ),
    output_mode: outputModeDefault(
      rasterParams.output_mode ?? raster.output_mode ?? raster.outputMode,
      state.raster.output_mode ?? "SixteenBit"
    ),
  };

  state.vector = {
    ...state.vector,
    vector_resolution: numberDefault(
      vectorParams.vector_resolution ??
        vector.vector_resolution ??
        vector.vectorResolution,
      state.vector.vector_resolution
    ),
    dwell: numberDefault(
      vectorParams.dwell ?? vector.dwell,
      state.vector.dwell
    ),
    latency_bytes: numberDefault(
      vectorParams.latency_bytes ?? vector.latency_bytes ?? vector.latency,
      state.vector.latency_bytes
    ),
    output_mode: outputModeDefault(
      vectorParams.output_mode ?? vector.output_mode ?? vector.outputMode,
      state.vector.output_mode
    ),
    pre_process: booleanDefault(
      vectorParams.pre_process ??
        vector.pre_process ??
        vector.preProcess,
      state.vector.pre_process
    ),
    do_validate: booleanDefault(
      vectorParams.do_validate ??
        vector.do_validate ??
        vector.doValidate,
      state.vector.do_validate
    ),
  };
}

function normalizeRasterPatch(
  patch: Partial<RasterRequest>,
  current: RasterRequest
): Partial<RasterRequest> {
  return {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, "frame_blank")
      ? { frame_blank: booleanDefault(patch.frame_blank, current.frame_blank) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "do_validate")
      ? { do_validate: booleanDefault(patch.do_validate, current.do_validate) }
      : {}),
  };
}

function normalizeVectorPatch(
  patch: Partial<VectorRequest>,
  current: VectorRequest
): Partial<VectorRequest> {
  return {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, "pre_process")
      ? { pre_process: booleanDefault(patch.pre_process, current.pre_process) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "do_validate")
      ? { do_validate: booleanDefault(patch.do_validate, current.do_validate) }
      : {}),
  };
}

function normalizeROIPatch(
  patch: Partial<ROIState>,
  current: ROIState
): Partial<ROIState> {
  return {
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, "show_grid")
      ? { show_grid: booleanDefault(patch.show_grid, current.show_grid) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "keep_loaded_bitmap_after_scan")
      ? {
          keep_loaded_bitmap_after_scan: booleanDefault(
            patch.keep_loaded_bitmap_after_scan,
            current.keep_loaded_bitmap_after_scan
          ),
        }
      : {}),
  };
}

function calibrationPatchTouchesConfirmedMapping(patch: Partial<ROIState>): boolean {
  return [
    "x_origin",
    "x_end",
    "y_origin",
    "y_end",
    "viewport_x_start",
    "viewport_x_end",
    "viewport_y_start",
    "viewport_y_end",
    "calibration_x_origin",
    "calibration_x_end",
    "calibration_y_origin",
    "calibration_y_end",
    "calibration_viewport_x_start",
    "calibration_viewport_x_end",
    "calibration_viewport_y_start",
    "calibration_viewport_y_end",
  ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

/* -------- blocking REST runs ------------------------------------------- */

export const runRasterValidated = createAsyncThunk<ScanResult, RasterRequest>(
  "scan/runRasterValidated",
  async (req, { signal }) => {
    const r = await fetch(apiUrl("/api/scan/raster/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify(req),
      signal,
    });
    if (!r.ok) throw new Error(await scanRunErrorMessage(r, "raster run"));
    return await readJsonResponse<ScanResult>(r, "raster run");
  }
);

export const runVectorValidated = createAsyncThunk<ScanResult, VectorRequest>(
  "scan/runVectorValidated",
  async (req, { signal }) => {
    const r = await fetch(apiUrl("/api/scan/vector/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify(req),
      signal,
    });
    if (!r.ok) throw new Error(await scanRunErrorMessage(r, "vector run"));
    return await readJsonResponse<ScanResult>(r, "vector run");
  }
);

async function scanRunErrorMessage(response: Response, prefix: string): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : "";
    if (message) return message;
  } catch {
    /* fall through to HTTP detail */
  }
  return `${prefix}: HTTP ${response.status}${text ? ` ${text}` : ""}`;
}

const slice = createSlice({
  name: "scan",
  initialState,
  reducers: {
    setKind(s, a: PayloadAction<ScanKind>) {
      s.kind = a.payload;
    },
    updateRaster(s, a: PayloadAction<Partial<RasterRequest>>) {
      s.raster = { ...s.raster, ...normalizeRasterPatch(a.payload, s.raster) };
    },
    updateVector(s, a: PayloadAction<Partial<VectorRequest>>) {
      s.vector = { ...s.vector, ...normalizeVectorPatch(a.payload, s.vector) };
    },
    updateBeamEnergyEv(s, a: PayloadAction<number>) {
      s.beamEnergyEv = floatDefault(a.payload, s.beamEnergyEv);
    },
    updateROI(s, a: PayloadAction<Partial<ROIState>>) {
      s.roi = { ...s.roi, ...normalizeROIPatch(a.payload, s.roi) };
      if (calibrationPatchTouchesConfirmedMapping(a.payload)) {
        s.roi.calibration_confirmed = false;
      }
      if ("selection" in a.payload) {
        s.raster.roi = a.payload.selection ?? null;
        s.vector.roi = a.payload.selection ?? null;
      }
    },
    confirmROICalibration(s) {
      s.roi.x_origin = s.roi.calibration_x_origin;
      s.roi.x_end = s.roi.calibration_x_end;
      s.roi.y_origin = s.roi.calibration_y_origin;
      s.roi.y_end = s.roi.calibration_y_end;
      // After calibration is applied, the operator works against the
      // full live canvas with the new DUT scale. The draft calibration
      // viewport remains stored separately for the next calibration pass.
      s.roi.viewport_x_start = 0;
      s.roi.viewport_x_end = 640;
      s.roi.viewport_y_start = 0;
      s.roi.viewport_y_end = 640;
      s.roi.calibration_enabled = false;
      s.roi.calibration_confirmed = true;
      s.roi.selection = null;
      s.raster.roi = null;
      s.vector.roi = null;
    },
    clearROIImage(s) {
      s.roi.imageName = "No image selected";
      s.roi.imageDataUrl = null;
      s.roi.imageKind = "none";
    },
    clearROISelection(s) {
      s.roi.selection = null;
      s.raster.roi = null;
      s.vector.roi = null;
    },
    clearLastResult(s) {
      s.lastResult = null;
    },
    clearLastOutput(s) {
      s.lastOutput = null;
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
      s.lastOutput = null;
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
      a: PayloadAction<{
        chunks: number;
        kind?: "raster" | "vector";
        csv_filename?: string | null;
        image_filename?: string | null;
      } | undefined>
    ) {
      s.phase = "completed";
      if (a.payload?.chunks !== undefined) s.chunksReceived = a.payload.chunks;
      if (a.payload?.kind) {
        s.lastOutput = {
          kind: a.payload.kind,
          csv_filename: a.payload.csv_filename ?? null,
          image_filename: a.payload.image_filename ?? null,
        };
      }
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
      s.lastOutput = null;
    },
  },
  extraReducers: (b) => {
    b.addCase(runRasterValidated.pending, (s) => {
      s.phase = "running";
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.lastResult = null;
      s.lastOutput = null;
      s.errorMessage = null;
    });
    b.addCase(runRasterValidated.fulfilled, (s, a) => {
      s.phase = "completed";
      s.lastResult = a.payload;
      s.lastOutput = {
        kind: "raster",
        csv_filename: a.payload.csv_filename ?? null,
        image_filename: a.payload.image_filename ?? null,
      };
    });
    b.addCase(runRasterValidated.rejected, (s, a) => {
      if (a.meta.aborted) {
        s.phase = "idle";
        s.errorMessage = null;
        return;
      }
      s.phase = "error";
      s.errorMessage = a.error.message ?? "raster run failed";
    });
    b.addCase(runVectorValidated.pending, (s) => {
      s.phase = "running";
      s.bytesReceived = 0;
      s.chunksReceived = 0;
      s.lastResult = null;
      s.lastOutput = null;
      s.errorMessage = null;
    });
    b.addCase(runVectorValidated.fulfilled, (s, a) => {
      s.phase = "completed";
      s.lastResult = a.payload;
      s.lastOutput = {
        kind: "vector",
        csv_filename: a.payload.csv_filename ?? null,
        image_filename: a.payload.image_filename ?? null,
      };
    });
    b.addCase(runVectorValidated.rejected, (s, a) => {
      if (a.meta.aborted) {
        s.phase = "idle";
        s.errorMessage = null;
        return;
      }
      s.phase = "error";
      s.errorMessage = a.error.message ?? "vector run failed";
    });
    b.addCase(fetchDefaults.fulfilled, (s, a) => {
      applyServerDefaults(s, a.payload);
      s.beamEnergyEv = floatDefault(a.payload.ev, s.beamEnergyEv);
    });
  },
});

export const {
  setKind,
  updateRaster,
  updateVector,
  updateBeamEnergyEv,
  updateROI,
  confirmROICalibration,
  clearROIImage,
  clearROISelection,
  clearLastResult,
  clearLastOutput,
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
