/**
 * Quick checks on a file picked for CONFIGURATION > Admin > Calibration > Import, done before it is read and sent.
 * They only catch what is obvious from the file itself (type, size, emptiness, an Export CSV of the other column);
 * the full validation of a calibration CSV (quoting, columns, keys, values, duplicates ...) is done by the server, see
 * ionbeam-web/backend/src/calibrationCsvFile.ts, and the catalog checks by the database.
 */
import type { CalibrationEquipmentType } from "../types/calibration";

/** Same bound as MAX_IMPORT_CHARS in calibrationRoutes.ts (8 M characters; bytes are a close upper bound). */
export const IMPORT_MAX_BYTES = 8_000_000;
export const IMPORT_ACCEPT = ".txt,.TXT,.csv,.CSV,text/plain,text/csv";

export type ImportFileKind = "vendor" | "csv";

export type ImportPrecheck =
  | { ok: true; kind: ImportFileKind }
  | { ok: false; reason: "extension" | "empty" | "tooLarge" | "wrongType"; fileType?: CalibrationEquipmentType };

const EXPORT_NAME = /calibration_(\d+)_(FIB|SEM)_r(\d+)/i;

/** What an Export CSV file name says (calibration_<equipment>_<FIB|SEM>_r<revision>.csv), or null. */
export function exportFileInfo(name: string): { equipmentId: number; type: CalibrationEquipmentType; revision: number } | null {
  const m = EXPORT_NAME.exec(name);
  return m ? { equipmentId: Number(m[1]), type: m[2].toUpperCase() as CalibrationEquipmentType, revision: Number(m[3]) } : null;
}

export function precheckImportFile(file: { name: string; size: number }, type: CalibrationEquipmentType): ImportPrecheck {
  const name = file.name.trim();
  const kind: ImportFileKind | null = /\.csv$/i.test(name) ? "csv" : /\.txt$/i.test(name) ? "vendor" : null;
  if (kind === null) return { ok: false, reason: "extension" };
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, reason: "tooLarge" };
  if (kind === "csv") {
    const info = exportFileInfo(name);
    if (info && info.type !== type) return { ok: false, reason: "wrongType", fileType: info.type };
  }
  return { ok: true, kind };
}
