/**
 * Dimension Cal (CONFIGURATION > Calibrate > DIMENTION CAL) — one current world-coordinate mapping per
 * equipment, stored server-side so it's shared across browsers/operators instead of living only in one
 * browser's localStorage. See IobeamAdmin/Sql/005_dimension_calibration_schema.sql for the schema and the
 * two stored functions this wraps, and dimensionCalibrationRoutes.ts for the HTTP surface.
 */
import { queryAdminStored } from "./adminDbRepository";

export type DimensionCalibrationSourceKind = "manual" | "scanGeometry";

export interface DimensionCalibrationRow {
  equipment_id: number;
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  viewport_x_start: number;
  viewport_x_end: number;
  viewport_y_start: number;
  viewport_y_end: number;
  scale_unit: string;
  source_kind: DimensionCalibrationSourceKind;
  source_equipment_type: "FIB" | "SEM" | null;
  source_profile_revision: number | null;
  source_at: string;
  updated_by: number | null;
  updated_at: string;
}

export type DimensionCalibrationInput = Omit<DimensionCalibrationRow, "updated_at">;

function parseRow(raw: string): DimensionCalibrationRow | null {
  const parsed = JSON.parse(raw.trim() || "null") as unknown;
  return parsed && typeof parsed === "object" ? (parsed as DimensionCalibrationRow) : null;
}

export async function getDimensionCalibrationFromDb(equipmentId: number): Promise<DimensionCalibrationRow | null> {
  const raw = await queryAdminStored(
    "SELECT fn_get_dimension_calibration($$payload$$);",
    { equipment_id: equipmentId },
    "null",
  );
  return parseRow(raw);
}

export async function saveDimensionCalibrationToDb(input: DimensionCalibrationInput): Promise<DimensionCalibrationRow> {
  const raw = await queryAdminStored("SELECT fn_upsert_dimension_calibration($$payload$$);", input);
  const row = parseRow(raw);
  if (!row) throw new Error("dimension calibration save did not return a row");
  return row;
}
