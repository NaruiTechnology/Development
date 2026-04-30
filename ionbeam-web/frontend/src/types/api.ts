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
  save_csv: boolean;
  csv_dir: string | null;
  do_validate: boolean;
}

export type VectorPattern = "default" | "custom";

export interface VectorRequest {
  pattern: VectorPattern;
  points: Array<[number, number, number]> | null;
  latency_bytes: number;
  output_mode: "SixteenBit" | "EightBit";
  cookie: number;
  pre_process: boolean;
  save_csv: boolean;
  csv_dir: string | null;
  do_validate: boolean;
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
  csv_path?: string | null;
  validation?: ScanValidation | null;
}

/** Server defaults harvested from streamData.json by GET /defaults. */
export interface ServerDefaults {
  raster: Record<string, unknown>;
  vector: Record<string, unknown>;
}
