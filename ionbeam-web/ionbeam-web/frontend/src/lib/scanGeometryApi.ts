/** Client of /api/admin/scan-geometry (ionbeam-web/backend/src/scanGeometryConfig.ts). */
import { scanAuthHeaders } from "./authIdentity";
import { apiUrl } from "./backendUrl";
import { readJsonResponse } from "./readJsonResponse";
import { parseScanGeometryConfig, type ScanGeometryConfig, type StreamScanDefaults } from "./scanGeometry";

export interface ScanGeometryState {
  config: ScanGeometryConfig | null;
  stream: StreamScanDefaults;
}

interface WireResponse {
  ok?: boolean;
  error?: string;
  scan_geometry?: unknown;
  stream?: { resolution?: unknown; dwell?: unknown; adcHalfPeriod?: unknown; transforms?: unknown };
}

function toState(data: WireResponse): ScanGeometryState {
  const s = data.stream ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const tr = s.transforms && typeof s.transforms === "object" ? (s.transforms as Record<string, unknown>) : {};
  return {
    config: parseScanGeometryConfig(data.scan_geometry),
    stream: {
      resolution: n(s.resolution),
      dwell: n(s.dwell),
      adcHalfPeriod: n(s.adcHalfPeriod),
      transforms: { xflip: tr.xflip === true, yflip: tr.yflip === true, rotate90: tr.rotate90 === true },
    },
  };
}

export async function fetchScanGeometry(): Promise<ScanGeometryState> {
  const response = await fetch(apiUrl("/api/admin/scan-geometry"), { headers: scanAuthHeaders() });
  const data = await readJsonResponse<WireResponse>(response, "scan geometry");
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `scan geometry: HTTP ${response.status}`);
  return toState(data);
}

/** Store (or, with null, remove) the applied geometry. */
export async function saveScanGeometry(config: Omit<ScanGeometryConfig, "applied_at" | "applied_by"> | null): Promise<ScanGeometryState> {
  const response = await fetch(apiUrl("/api/admin/scan-geometry"), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({ scan_geometry: config }),
  });
  const data = await readJsonResponse<WireResponse>(response, "save scan geometry");
  if (!response.ok || data.ok === false) throw new Error(data.error ?? `save scan geometry: HTTP ${response.status}`);
  return toState(data);
}
