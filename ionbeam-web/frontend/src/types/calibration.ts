/**
 * Wire types of /api/admin/iobeam/calibration/* - kept in step with ionbeam-web/backend/src/calibrationRepository.ts
 * (the same convention as types/api.ts, which mirrors the FastAPI models).
 */

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
export type CalibrationReviewState = "imported" | "reviewed" | "confirmed";

export interface CalibrationEnumOption {
  value: number;
  label: string;
}

export interface CalibrationDefinition {
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
  source_vendor: string;
  source_document: string;
  source_reference: string;
  is_read_only: boolean;
  sort_order: number;
  group_code: string;
  vendor_name: string | null;
  param_class: CalibrationParamClass;
  access_level: CalibrationAccessLevel;
  ui_widget: "number" | "toggle" | "select" | "readonly" | "raw" | "text";
  enum_options: CalibrationEnumOption[];
  table_code: string | null;
  row_key: string | null;
  col_key: string | null;
  semantics_known: boolean;
  assign_conf: "high" | "medium" | "low" | null;
  review_state: CalibrationReviewState;
  shared_hardware: boolean;
  limit_min_key: string | null;
  limit_max_key: string | null;
}

export interface CalibrationProfile {
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

export interface CalibrationStoredValue {
  definition_id: number;
  parameter_key: string;
  value: unknown;
  notes: string;
  verified_at: string | null;
  updated_at?: string;
}

export interface CalibrationBundle {
  ok: true;
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile: CalibrationProfile | null;
  definitions: CalibrationDefinition[];
  values: CalibrationStoredValue[];
  total?: number;
  limit?: number;
  offset?: number;
  result?: CalibrationWriteResult;
}

export interface CalibrationChange {
  parameter_key: string;
  old: unknown;
  new: unknown;
}

export interface CalibrationWriteResult {
  revision: number;
  changed: number;
  unchanged: number;
  changes: CalibrationChange[];
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

export interface CalibrationQuality {
  definitions: number;
  undocumented: number;
  low_confidence: number;
  unreviewed: number;
  with_values: number;
}

export interface CalibrationGroupsResponse {
  ok: true;
  equipment_type: CalibrationEquipmentType;
  groups: CalibrationGroup[];
  quality: CalibrationQuality;
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
  minimum_value: number | null;
  maximum_value: number | null;
  enum_options: CalibrationEnumOption[];
  default_value: unknown;
  source_reference: string;
  value: unknown;
}

export interface CalibrationTableResponse {
  ok: true;
  profile: CalibrationProfile | null;
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

export interface CalibrationRevision {
  revision: number;
  snapshot: Record<string, unknown>;
  created_at: string;
  created_by: number | null;
  created_by_name?: string | null;
  kind?: "edit" | "import" | "restore";
  reason?: string;
  source_ref?: string;
  changed_count?: number;
  changes?: CalibrationChange[];
  changes_truncated?: boolean;
}

export interface CalibrationImportPreview {
  ok: true;
  dry_run?: boolean;
  format: "machine-data" | "registry";
  lines: number;
  skipped_binary: number;
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
  changes?: CalibrationChange[];
}

export interface EquipmentRecord {
  id: number;
  name: string;
  model: string;
  serial_number: string;
  site: string;
  description: string;
}

/** A user's edit of one parameter: a new value, or removal of the stored value. */
export type CalibrationEdit = { kind: "set"; value: unknown } | { kind: "clear" };
