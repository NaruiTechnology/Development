/** Client of /api/admin/iobeam/dimension-calibration/:equipmentId (see backend/src/dimensionCalibrationRoutes.ts). */
import { scanAuthHeaders } from "./authIdentity";
import { apiUrl } from "./backendUrl";
import type { DimensionCalibrationValues } from "./dimensionCalibrationPersistence";
import { readJsonResponse } from "./readJsonResponse";

const BASE = "/api/admin/iobeam/dimension-calibration";

interface DimensionCalibrationResponse {
  ok: boolean;
  calibration: DimensionCalibrationValues | null;
  error?: string;
}

/** Null on any failure (offline, signed out, not yet saved for this equipment) — callers fall back to localStorage. */
export async function fetchDimensionCalibrationRemote(equipmentId: number): Promise<DimensionCalibrationValues | null> {
  try {
    const response = await fetch(apiUrl(`${BASE}/${equipmentId}`), { headers: scanAuthHeaders() });
    if (!response.ok) return null;
    const data = await readJsonResponse<DimensionCalibrationResponse>(response, "dimension calibration fetch");
    return data.ok ? data.calibration : null;
  } catch {
    return null;
  }
}

/** Best-effort: failures are swallowed (localStorage already has the value; this is the shared-copy sync). */
export async function saveDimensionCalibrationRemote(equipmentId: number, values: DimensionCalibrationValues): Promise<void> {
  try {
    await fetch(apiUrl(`${BASE}/${equipmentId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify(values),
    });
  } catch {
    /* offline or signed out — the local copy still applied */
  }
}
