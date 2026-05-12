/**
 * Mirrors the Pydantic models in glasgow_service.models. If those models
 * change, update this file in lockstep — the API contract is the single
 * source of truth.
 */

export type DeviceState =
  | "disconnected"
  | "connecting"
  | "idle"
  | "busy"
  | "error";

export interface ServiceStatus {
  state: DeviceState;
  last_error: string | null;
  scans_completed: number;
  chunks_in_flight: number;
}

export interface RasterRequest {
  resolution: number;     // 1..2048
  dwell: number;          // 1..65535
  latency_bytes: number;  // >= 2
  frame_blank: boolean;
  cookie: number;         // 0..65535
  /** Output bit-depth for the SynchronizeCommand. Backend defaults to
   *  "SixteenBit" when omitted, so this field is optional for frontends
   *  that don't expose a control for it. */
  output_mode?: "SixteenBit" | "EightBit";
  do_validate: boolean;
  roi?: ROIRequest | null;
  /** Browser-provided grayscale crop for simulation-only raster scans.
   *  Production hardware ignores it and uses the DAC ROI normally. */
  simulation_bitmap?: SimulationBitmap | null;
}

export type VectorPattern = "default" | "custom";

export interface VectorRequest {
  pattern: VectorPattern;
  points: Array<[number, number, number]> | null;
  /** Default-pattern density on each axis. Allowed: 256, 512, 1024, 2048.
   *  Coverage stays the full DAC range; smaller values just sample
   *  sparser. Ignored when pattern=custom. */
  vector_resolution: number;
  latency_bytes: number;
  output_mode: "SixteenBit" | "EightBit";
  cookie: number;
  pre_process: boolean;
  do_validate: boolean;
  roi?: ROIRequest | null;
  /** Browser-provided grayscale crop for simulation-only vector scans.
   *  Production hardware ignores it and uses the DAC points normally. */
  simulation_bitmap?: SimulationBitmap | null;
}

export interface SimulationBitmap {
  width: number;
  height: number;
  pixels: number[];
}

export interface ROIRequest {
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface ScanValidation {
  passed: boolean;
  checks: ValidationCheck[];
}

export interface ScanResult {
  kind: "raster" | "vector";
  chunks: number;
  bytes: number;

  // raster-only:
  resolution?: number | null;
  dwell?: number | null;
  expected_chunks?: number | null;
  pixels_per_chunk?: number | null;

  // vector-only:
  process_time_s?: number | null;

  // shared:
  send_time_s?: number | null;
  /** True when the server is holding the chunk buffer for this scan,
   *  enabling the /scan/last/csv and /scan/last/figure downloads. */
  has_data?: boolean;
  validation?: ScanValidation | null;
}

/** Returned by GET /scan/last/meta. Null when no scan has run yet. */
export interface LastScanMeta {
  kind: "raster" | "vector";
  chunks: number;
  source: "validated" | "stream" | null;
  resolution?: number | null;
  latency_bytes?: number | null;
  pattern?: string | null;
}

/** Server defaults harvested from streamData.json by GET /defaults.
 *
 * `raster` / `vector` are the raw camelCase JSON blocks from
 * streamData.json — used by older code paths and the display-render
 * extras (lineShiftPerXRow, adcLatency, etc.).
 *
 * `raster_params` / `vector_params` are the normalized snake_case
 * params produced by RasterParams.to_public_dict() / VectorParams
 * .to_public_dict() on the server. These are the preferred shape
 * for new code — they map 1:1 to RasterRequest / VectorRequest
 * fields, no client-side translation needed.
 */
export interface ServerDefaults {
  raster: Record<string, unknown>;
  vector: Record<string, unknown>;
  raster_params?: Record<string, unknown>;
  vector_params?: Record<string, unknown>;
  is_production?: boolean;
}
