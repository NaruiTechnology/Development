/** Client of /api/admin/iobeam/calibration/* (see ionbeam-web/backend/src/calibrationRoutes.ts). */
import { scanAuthHeaders } from "./authIdentity";
import { apiUrl } from "./backendUrl";
import { readJsonResponse } from "./readJsonResponse";
import type {
  CalibrationBundle,
  CalibrationDefinition,
  CalibrationEquipmentType,
  CalibrationGroupsResponse,
  CalibrationImportPreview,
  CalibrationRevision,
  CalibrationTableResponse,
  CalibrationWriteResult,
  EquipmentRecord,
} from "../types/calibration";

const BASE = "/api/admin/iobeam/calibration";

/** A non-2xx answer; `code` / `errors` carry what the database reported (forbidden_role, risk_ack_required, ...). */
export class CalibrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly errors: Array<{ parameter_key?: string; code: string; message: string; line?: number }> = [],
    readonly currentRevision?: number,
    /** how many problems the server found in total (errors[] may be capped) */
    readonly totalErrors?: number,
  ) {
    super(message);
    this.name = "CalibrationApiError";
  }
}

export interface CalibrationListQuery {
  group_code?: string;
  q?: string;
  access_level?: string;
  undocumented?: boolean;
  low_confidence?: boolean;
  include_cells?: boolean;
  keys?: string[];
  limit?: number;
  offset?: number;
}

function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`${BASE}${path}`), {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...scanAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readJsonResponse<Record<string, unknown>>(response, `calibration ${method} ${path}`);
  if (!response.ok || data.ok === false) {
    throw new CalibrationApiError(
      String(data.error ?? `request failed (${response.status})`),
      response.status,
      String(data.code ?? "failed"),
      Array.isArray(data.errors) ? (data.errors as CalibrationApiError["errors"]) : [],
      typeof data.current_revision === "number" ? data.current_revision : undefined,
      typeof data.total_errors === "number" ? data.total_errors : undefined,
    );
  }
  return data as T;
}

export async function fetchEquipmentList(): Promise<EquipmentRecord[]> {
  const response = await fetch(apiUrl("/api/admin/iobeam/equipment"), { headers: scanAuthHeaders() });
  const data = await readJsonResponse<{ ok?: boolean; equipment?: EquipmentRecord[]; error?: string }>(response, "equipment");
  if (!response.ok || !Array.isArray(data.equipment)) throw new Error(data.error ?? "could not load the equipment list");
  return data.equipment.filter((e) => Number.isInteger(e.id) && e.id > 0);
}

export async function fetchCurrentRole(): Promise<number | null> {
  const response = await fetch(apiUrl("/api/admin/iobeam/auth/current-account"), { headers: scanAuthHeaders() });
  if (!response.ok) return null;
  const data = await readJsonResponse<{ user?: { role?: number } | null }>(response, "current account");
  return typeof data.user?.role === "number" ? data.user.role : null;
}

export const calibrationApi = {
  groups: (type: CalibrationEquipmentType, equipmentId: number | null) =>
    request<CalibrationGroupsResponse>("GET", `/groups${queryString({ equipment_type: type, equipment_id: equipmentId })}`),

  bundle: (equipmentId: number, type: CalibrationEquipmentType, query: CalibrationListQuery = {}) =>
    request<CalibrationBundle>("GET", `/${equipmentId}/${type}${queryString({ ...query })}`),

  table: (equipmentId: number, type: CalibrationEquipmentType, tableCode: string) =>
    request<CalibrationTableResponse>("GET", `/${equipmentId}/${type}/tables/${encodeURIComponent(tableCode)}`),

  save: (
    equipmentId: number,
    type: CalibrationEquipmentType,
    body: {
      values: Array<{ parameter_key: string; value?: unknown; clear?: boolean; notes?: string; verified?: boolean }>;
      reason?: string;
      expected_revision?: number;
      acknowledge_risk?: boolean;
    },
  ) => request<CalibrationBundle>("PUT", `/${equipmentId}/${type}/values`, body),

  history: (equipmentId: number, type: CalibrationEquipmentType, options: { parameter_key?: string; limit?: number; offset?: number } = {}) =>
    request<{ ok: true; revisions: CalibrationRevision[] }>("GET", `/${equipmentId}/${type}/history${queryString({ ...options })}`),

  revision: (equipmentId: number, type: CalibrationEquipmentType, revision: number) =>
    request<{ ok: true; revision: number; changes: CalibrationRevision["changes"] }>(
      "GET",
      `/${equipmentId}/${type}/history/${revision}`,
    ),

  restore: (
    equipmentId: number,
    type: CalibrationEquipmentType,
    body: { revision: number; reason?: string; acknowledge_risk?: boolean; dry_run?: boolean; expected_revision?: number },
  ) => request<{ ok: true; result: CalibrationWriteResult }>("POST", `/${equipmentId}/${type}/restore`, body),

  importFile: (
    equipmentId: number,
    type: CalibrationEquipmentType,
    body: { file_name: string; content: string; dry_run: boolean; reason?: string; acknowledge_risk?: boolean },
  ) => request<CalibrationImportPreview>("POST", `/${equipmentId}/${type}/import`, body),

  updateDefinition: (
    id: number,
    body: {
      display_name?: string;
      description?: string;
      unit?: string;
      semantics_known?: boolean;
      review_state?: "imported" | "reviewed" | "confirmed";
    },
  ) => request<{ ok: true; definition: CalibrationDefinition }>("PATCH", `/definitions/${id}`, body),

  /** The whole sheet as CSV. Fetched with the auth header (not ?auth=) so the session token never lands in access logs. */
  exportCsv: async (equipmentId: number, type: CalibrationEquipmentType): Promise<{ blob: Blob; filename: string }> => {
    const response = await fetch(apiUrl(`${BASE}/${equipmentId}/${type}/export.csv`), { headers: scanAuthHeaders() });
    if (!response.ok) {
      const data = await readJsonResponse<{ error?: string; code?: string }>(response, "calibration export");
      throw new CalibrationApiError(data.error ?? `export failed (${response.status})`, response.status, data.code ?? "failed");
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `calibration_${equipmentId}_${type}.csv`;
    return { blob: await response.blob(), filename };
  },
};
