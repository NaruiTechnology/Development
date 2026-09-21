import { queryAdminStored } from "./adminDbRepository";

export type CalibrationEquipmentType = "FIB" | "SEM";
export type CalibrationValueType = "number" | "integer" | "boolean" | "text" | "enum";

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
}

export interface EquipmentCalibrationBundle {
  ok: true;
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile: EquipmentCalibrationProfile | null;
  definitions: CalibrationParameterDefinition[];
  values: EquipmentCalibrationValue[];
}

export interface EquipmentCalibrationWrite {
  equipment_id: number;
  equipment_type: CalibrationEquipmentType;
  profile_name: string;
  notes: string;
  actor_user_id: number | null;
  values: Array<{
    parameter_key: string;
    value: unknown;
    notes?: string;
  }>;
}

export interface EquipmentCalibrationRevision {
  revision: number;
  snapshot: Record<string, unknown>;
  created_at: string;
  created_by: number | null;
}

export async function getEquipmentCalibrationBundle(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
): Promise<EquipmentCalibrationBundle> {
  const raw = await queryAdminStored(
    "SELECT fn_get_equipment_calibration($$payload$$);",
    { equipment_id: equipmentId, equipment_type: equipmentType },
    "{}",
  );
  return parseBundle(raw);
}

export async function saveEquipmentCalibration(
  payload: EquipmentCalibrationWrite,
): Promise<EquipmentCalibrationBundle> {
  const raw = await queryAdminStored(
    "SELECT fn_upsert_equipment_calibration($$payload$$);",
    payload,
    "{}",
  );
  return parseBundle(raw);
}

export async function listEquipmentCalibrationHistory(
  equipmentId: number,
  equipmentType: CalibrationEquipmentType,
): Promise<EquipmentCalibrationRevision[]> {
  const raw = await queryAdminStored(
    "SELECT fn_list_equipment_calibration_history($$payload$$);",
    { equipment_id: equipmentId, equipment_type: equipmentType },
    "[]",
  );
  const parsed = JSON.parse(raw.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("calibration history query returned an invalid response");
  }
  return parsed as EquipmentCalibrationRevision[];
}

function parseBundle(raw: string): EquipmentCalibrationBundle {
  const parsed = JSON.parse(raw.trim() || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("calibration query returned an invalid response");
  }
  const bundle = parsed as Partial<EquipmentCalibrationBundle>;
  if (
    bundle.ok !== true ||
    !Number.isInteger(bundle.equipment_id) ||
    (bundle.equipment_type !== "FIB" && bundle.equipment_type !== "SEM") ||
    !Array.isArray(bundle.definitions) ||
    !Array.isArray(bundle.values)
  ) {
    throw new Error("calibration query returned an incomplete response");
  }
  return bundle as EquipmentCalibrationBundle;
}
