import fs from "node:fs";

import { resolveSqlFile } from "./adminDbService";
import { queryAdminStored, runAdminSqlScript } from "./adminDbRepository";
import type { CalibrationCsvItem } from "./calibrationCsvFile";
import type { CalibrationImportItem as VendorImportItem } from "./calibrationVendorFile";

/** A line of a vendor file (matched by slot / registry path) or a row of a calibration CSV (matched by parameter_key). */
export type CalibrationImportItem = VendorImportItem | CalibrationCsvItem;

export type CalibrationEquipmentType = "FIB" | "SEM";
export type CalibrationValueType = "number" | "integer" | "boolean" | "text" | "enum";
export type CalibrationAccessLevel = "fixed" | "auto" | "service" | "adjustable";
export type CalibrationParamClass =
  | "identity"
  | "config"
  | "calibration"
  | "tuning"
  | "limit"
  | "preset"
  | "counter"
  | "unused"
  | "undocumented";

export interface CalibrationEnumOption {
  value: number;
  label: string;
}

export interface CalibrationParameterDefinition {
  id: number;
  equipment_type: CalibrationEquipmentType;
  parameter_key: string;
  category: string;
  display_name: string;
  description: string;
  value_type: CalibrationValueType;
  unit: string;
  minimum_value: number | null;
  maximum_value: number | null;
  default_value: unknown;
  enum_values: string[];
  source_vendor: string;
  source_document: string;
  source_url: string;
  source_reference: string;
  is_read_only: boolean;
  sort_order: number;
  // ---- extensions (all present in responses of fn_get_equipment_calibration) ----
  group_code?: string;
  vendor_name?: string | null;
  param_class?: CalibrationParamClass;
  access_level?: CalibrationAccessLevel;
  ui_widget?: "number" | "toggle" | "select" | "readonly" | "raw" | "text";
  enum_options?: CalibrationEnumOption[];
  unit_source?: "vendor" | "name" | "inferred" | null;
  table_code?: string | null;
  row_key?: string | null;
  col_key?: string | null;
  semantics_known?: boolean;
  assign_basis?: string | null;
  assign_conf?: "high" | "medium" | "low" | null;
  review_state?: "imported" | "reviewed" | "confirmed";
  applicability?: string[];
  shared_hardware?: boolean;
  adjustment_no?: string | null;
  limit_min_key?: string | null;
  limit_max_key?: string | null;
}

export interface EquipmentCalibrationProfile {
  id: number;
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile_name: string;
  revision: number;
  notes: string;
  is_active: boolean;
  updated_at: string;
  updated_by: number | null;
}

export interface EquipmentCalibrationValue {
  definition_id: number;
  parameter_key: string;
  value: unknown;
  notes: string;
  verified_at: string | null;
  updated_at?: string;
}

export interface CalibrationWriteResult {
  revision: number;
  changed: number;
  unchanged: number;
  annotated?: number;
  changes: Array<{ parameter_key: string; old: unknown; new: unknown }>;
  dry_run?: boolean;
}

export interface EquipmentCalibrationBundle {
  ok: true;
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile: EquipmentCalibrationProfile | null;
  definitions: CalibrationParameterDefinition[];
  values: EquipmentCalibrationValue[];
  total?: number;
  limit?: number;
  offset?: number;
  /** Present on save responses: what the write did. `definitions`/`values` then hold only the written parameters. */
  result?: CalibrationWriteResult;
}

export interface EquipmentCalibrationWrite {
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile_name: string;
  notes: string;
  actor_user_id: number | null;
  values: Array<{
    parameter_key: string;
    value?: unknown;
    notes?: string;
    /** stamp verified_at = now */
    verified?: boolean;
    /** remove the stored value */
    clear?: boolean;
  }>;
  reason?: string;
  /** optimistic locking: the revision the caller edited */
  expected_revision?: number;
  /** the caller confirmed they are changing a vendor-undocumented / fixed / low-confidence parameter */
  acknowledge_risk?: boolean;
  /** users.role of the caller; the database enforces the per-access-level minimum */
  actor_role?: number;
  dry_run?: boolean;
}

export interface EquipmentCalibrationRevision {
  revision: number;
  /** values changed by this revision (parameter_key -> new value) */
  snapshot: Record<string, unknown>;
  created_at: string;
  created_by: number | null;
  created_by_name?: string | null;
  kind?: "edit" | "import" | "restore";
  reason?: string;
  source_ref?: string;
  changed_count?: number;
  changes?: Array<{ parameter_key: string; old: unknown; new: unknown }>;
  changes_truncated?: boolean;
}

export interface CalibrationGroup {
  group_code: string;
  parent_code: string | null;
  label: string;
  sort_order: number;
  parameters: number;
  table_cells: number;
  undocumented: number;
  low_confidence: number;
  unreviewed: number;
  with_values: number;
  total_parameters: number;
  total_table_cells: number;
  total_undocumented: number;
  total_low_confidence: number;
  total_with_values: number;
  tables: Array<{ table_code: string; label: string; kind: "matrix" | "list" }>;
}

export interface CalibrationGroupsResponse {
  ok: true;
  equipment_type: CalibrationEquipmentType;
  groups: CalibrationGroup[];
  quality: { definitions: number; undocumented: number; low_confidence: number; unreviewed: number; with_values: number };
}

export interface CalibrationTableCell {
  row_key: string;
  col_key: string;
  definition_id: number;
  parameter_key: string;
  display_name: string;
  value_type: CalibrationValueType;
  unit: string;
  is_read_only: boolean;
  access_level: CalibrationAccessLevel;
  param_class: CalibrationParamClass;
  semantics_known: boolean;
  assign_conf: "high" | "medium" | "low" | null;
  review_state: string;
  minimum_value: number | null;
  maximum_value: number | null;
  enum_options: CalibrationEnumOption[];
  default_value: unknown;
  source_reference: string;
  value: unknown;
}

export interface CalibrationTableResponse {
  ok: true;
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile: EquipmentCalibrationProfile | null;
  table: {
    table_code: string;
    label: string;
    kind: "matrix" | "list";
    group_code: string;
    row_header: string | null;
    col_header: string | null;
    note: string | null;
    rows: Array<{ key: string; label: string; role?: string | null }>;
    cols: Array<{ key: string; label: string; unit?: string | null }>;
  };
  cells: CalibrationTableCell[];
}

export interface CalibrationQuery {
  profile_name?: string;
  group_code?: string;
  q?: string;
  param_class?: CalibrationParamClass;
  access_level?: CalibrationAccessLevel;
  undocumented?: boolean;
  low_confidence?: boolean;
  review_state?: "imported" | "reviewed" | "confirmed";
  include_cells?: boolean;
  keys?: string[];
  limit?: number;
  offset?: number;
}

export interface CalibrationImportRequest {
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile_name?: string;
  file_name: string;
  items: CalibrationImportItem[];
  dry_run: boolean;
  reason?: string;
  acknowledge_risk?: boolean;
  actor_user_id: number | null;
  actor_role: number;
}

export interface CalibrationImportResult {
  ok: true;
  dry_run?: boolean;
  matched: number;
  unmatched_count: number;
  unmatched: string[];
  other_type_count: number;
  rejected_count: number;
  rejected: Array<{ parameter_key: string; raw: string; message: string }>;
  warning_count: number;
  warnings: Array<{ parameter_key: string; raw: string; message: string }>;
  changed: number;
  unchanged: number;
  risky_changed: number;
  revision: number;
  changes?: Array<{ parameter_key: string; old: unknown; new: unknown }>;
}

/** A failure the database reported in-band ({ok:false,...}); `status` is the HTTP status the API should answer with. */
export class CalibrationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: unknown[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CalibrationRequestError";
  }
}

// ------------------------------------------------------------------------------------------ reads
export async function ensureCalibrationCatalog(): Promise<void> {
  if (!catalogReady) {
    catalogReady = seedIfEmpty().catch((err) => {
      catalogReady = null;
      throw err;
    });
  }
  await catalogReady;
}
let catalogReady: Promise<void> | null = null;

async function seedIfEmpty(): Promise<void> {
  const count = await queryAdminStored(
    "SELECT count(*) FROM ionbeam_asset.calibration_parameter_definition;",
    null,
    "0",
  );
  if (Number.parseInt(count, 10) > 0) return;
  await loadCalibrationCatalogSeed();
}

/** Load 004_calibration_seed.sql (idempotent; a re-load keeps human-edited names, see fn_seed_calibration_catalog). */
export async function loadCalibrationCatalogSeed(): Promise<void> {
  const sql = fs.readFileSync(resolveSqlFile("004_calibration_seed.sql"), "utf8");
  await runAdminSqlScript(sql);
}

export async function getEquipmentCalibrationBundle(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
  query: CalibrationQuery = {},
): Promise<EquipmentCalibrationBundle> {
  await ensureCalibrationCatalog();
  const raw = await queryAdminStored(
    "SELECT fn_get_equipment_calibration($$payload$$);",
    { ...query, equipment_id: equipmentId, equipment_type: equipmentType },
    "{}",
  );
  return parseBundle(raw);
}

export async function listCalibrationGroups(
  equipmentType: CalibrationEquipmentType,
  equipmentId: number | null,
  profileName?: string,
): Promise<CalibrationGroupsResponse> {
  await ensureCalibrationCatalog();
  const raw = await queryAdminStored(
    "SELECT fn_list_calibration_groups($$payload$$);",
    { equipment_type: equipmentType, equipment_id: equipmentId, profile_name: profileName },
    "{}",
  );
  return parseOk<CalibrationGroupsResponse>(raw, "calibration groups");
}

export async function getCalibrationTable(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
  tableCode: string,
  profileName?: string,
): Promise<CalibrationTableResponse> {
  await ensureCalibrationCatalog();
  const raw = await queryAdminStored(
    "SELECT fn_get_calibration_table($$payload$$);",
    { equipment_id: equipmentId, equipment_type: equipmentType, table_code: tableCode, profile_name: profileName },
    "{}",
  );
  return parseOk<CalibrationTableResponse>(raw, "calibration table");
}

export async function listEquipmentCalibrationHistory(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
  options: { profile_name?: string; parameter_key?: string; limit?: number; offset?: number } = {},
): Promise<EquipmentCalibrationRevision[]> {
  const raw = await queryAdminStored(
    "SELECT fn_list_equipment_calibration_history($$payload$$);",
    { ...options, equipment_id: equipmentId, equipment_type: equipmentType },
    "[]",
  );
  const parsed = JSON.parse(raw.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("calibration history query returned an invalid response");
  }
  return parsed as EquipmentCalibrationRevision[];
}

export async function getCalibrationRevision(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
  revision: number,
  profileName?: string,
): Promise<Record<string, unknown>> {
  const raw = await queryAdminStored(
    "SELECT fn_get_calibration_revision($$payload$$);",
    { equipment_id: equipmentId, equipment_type: equipmentType, revision, profile_name: profileName },
    "{}",
  );
  return parseOk<Record<string, unknown>>(raw, "calibration revision");
}

// ------------------------------------------------------------------------------------------ writes
export async function saveEquipmentCalibration(payload: EquipmentCalibrationWrite): Promise<EquipmentCalibrationBundle> {
  await ensureCalibrationCatalog();
  const raw = await queryAdminStored("SELECT fn_upsert_equipment_calibration($$payload$$);", payload, "{}");
  return parseBundle(raw);
}

export async function restoreCalibrationRevision(payload: {
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile_name?: string;
  revision: number;
  reason?: string;
  acknowledge_risk?: boolean;
  expected_revision?: number;
  dry_run?: boolean;
  actor_user_id: number | null;
  actor_role: number;
}): Promise<CalibrationWriteResult> {
  const raw = await queryAdminStored("SELECT fn_restore_equipment_calibration_revision($$payload$$);", payload, "{}");
  return parseOk<CalibrationWriteResult & { ok: true }>(raw, "calibration restore");
}

export async function importEquipmentCalibration(payload: CalibrationImportRequest): Promise<CalibrationImportResult> {
  await ensureCalibrationCatalog();
  const raw = await queryAdminStored("SELECT fn_import_equipment_calibration($$payload$$);", payload, "{}");
  return parseOk<CalibrationImportResult>(raw, "calibration import");
}

export async function updateCalibrationDefinition(payload: {
  id: number;
  actor_user_id: number | null;
  actor_role: number;
  display_name?: string;
  description?: string;
  unit?: string;
  param_class?: CalibrationParamClass;
  semantics_known?: boolean;
  review_state?: "imported" | "reviewed" | "confirmed";
  is_active?: boolean;
}): Promise<CalibrationParameterDefinition> {
  const raw = await queryAdminStored("SELECT fn_update_calibration_definition($$payload$$);", payload, "{}");
  return parseOk<{ ok: true; definition: CalibrationParameterDefinition }>(raw, "calibration definition").definition;
}

// ------------------------------------------------------------------------------------------ parsing
const STATUS_BY_ERROR: Record<string, number> = {
  forbidden_role: 403,
  risk_ack_required: 409,
  revision_conflict: 409,
  validation_failed: 422,
  "equipment not found": 404,
  "table not found": 404,
  "revision not found": 404,
  "profile not found": 404,
  "parameter not found": 404,
};

function parseObject(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw.trim() || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} query returned an invalid response`);
  }
  return parsed as Record<string, unknown>;
}

/** Turns the database's in-band `{ok:false, error, errors?, message?}` into a CalibrationRequestError. */
function throwIfFailed(obj: Record<string, unknown>, label: string): void {
  if (obj.ok === false) {
    const code = String(obj.error ?? "failed");
    const details = Array.isArray(obj.errors) ? obj.errors : [];
    const first = details[0] as { message?: string } | undefined;
    const message = String(obj.message ?? first?.message ?? code);
    const { ok: _ok, error: _error, errors: _errors, message: _message, ...extra } = obj;
    // a batch rejected only because of the caller's role is a 403, not a data problem (422)
    const roleOnly =
      code === "validation_failed" &&
      details.length > 0 &&
      details.every((d) => (d as { code?: string }).code === "forbidden_role");
    const effective = roleOnly ? "forbidden_role" : code;
    throw new CalibrationRequestError(message, STATUS_BY_ERROR[effective] ?? 400, effective, details, extra);
  }
  if (obj.ok !== true) {
    throw new Error(`${label} query returned an incomplete response`);
  }
}

function parseOk<T>(raw: string, label: string): T {
  const obj = parseObject(raw, label);
  throwIfFailed(obj, label);
  return obj as unknown as T;
}

function parseBundle(raw: string): EquipmentCalibrationBundle {
  const bundle = parseObject(raw, "calibration") as Partial<EquipmentCalibrationBundle>;
  throwIfFailed(bundle as Record<string, unknown>, "calibration");
  if (
    !Number.isInteger(bundle.equipment_id) ||
    (bundle.equipment_type !== "FIB" && bundle.equipment_type !== "SEM") ||
    !Array.isArray(bundle.definitions) ||
    !Array.isArray(bundle.values)
  ) {
    throw new Error("calibration query returned an incomplete response");
  }
  return bundle as EquipmentCalibrationBundle;
}
