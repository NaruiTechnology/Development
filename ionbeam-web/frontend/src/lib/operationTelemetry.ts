import { scanAuthHeaders } from "./authIdentity";
import { apiUrl } from "./backendUrl";
import { readJsonResponse } from "./readJsonResponse";

export interface ScanOperationStartContext {
  kind: "raster" | "vector";
  start_xy: number;
  end_xy: number;
  dwell: number;
  scale_unit: string;
  ev: number;
  scan_parameters: Record<string, unknown>;
}

export interface ScanOperationOutputContext {
  activityId: Promise<number | null> | number | null;
  kind: "raster" | "vector";
  chunks?: number;
  resolution?: number;
  latency_bytes?: number;
  vector_resolution?: number;
  scan_result: Record<string, unknown>;
}

export async function recordScanOperationStart(
  context: ScanOperationStartContext,
): Promise<number | null> {
  try {
    const r = await fetch(apiUrl("/api/admin/iobeam/operation/input-setup"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify(context),
    });
    if (!r.ok) {
      const text = await r.text();
      console.warn(`[operation-telemetry] input setup failed: HTTP ${r.status} ${text}`);
      return null;
    }
    const data = await readJsonResponse<{ ok?: boolean; activity_id?: number }>(
      r,
      "operation input setup"
    );
    const activityId = Number(data.activity_id);
    return Number.isInteger(activityId) && activityId > 0 ? activityId : null;
  } catch (err) {
    console.warn("[operation-telemetry] failed to record scan input", err);
    return null;
  }
}

export async function recordScanOperationOutput(
  context: ScanOperationOutputContext,
): Promise<void> {
  try {
    const activityId = await context.activityId;
    if (!Number.isInteger(activityId ?? NaN) || (activityId ?? 0) <= 0) {
      return;
    }
    const r = await fetch(apiUrl("/api/admin/iobeam/operation/output-data"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify({
        activity_id: activityId,
        kind: context.kind,
        chunks: context.chunks ?? 0,
        resolution: context.resolution ?? 0,
        latency_bytes: context.latency_bytes ?? 0,
        vector_resolution: context.vector_resolution ?? 0,
        scan_result: context.scan_result,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.warn(`[operation-telemetry] output data failed: HTTP ${r.status} ${text}`);
    }
  } catch (err) {
    console.warn("[operation-telemetry] failed to record scan output", err);
  }
}
