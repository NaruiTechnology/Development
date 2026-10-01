"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDimensionCalibrationFromDb = getDimensionCalibrationFromDb;
exports.saveDimensionCalibrationToDb = saveDimensionCalibrationToDb;
/**
 * Dimension Cal (CONFIGURATION > Calibrate > DIMENTION CAL) — one current world-coordinate mapping per
 * equipment, stored server-side so it's shared across browsers/operators instead of living only in one
 * browser's localStorage. See IobeamAdmin/Sql/005_dimension_calibration_schema.sql for the schema and the
 * two stored functions this wraps, and dimensionCalibrationRoutes.ts for the HTTP surface.
 */
const adminDbRepository_1 = require("./adminDbRepository");
function parseRow(raw) {
    const parsed = JSON.parse(raw.trim() || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
}
async function getDimensionCalibrationFromDb(equipmentId) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_get_dimension_calibration($$payload$$);", { equipment_id: equipmentId }, "null");
    return parseRow(raw);
}
async function saveDimensionCalibrationToDb(input) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_upsert_dimension_calibration($$payload$$);", input);
    const row = parseRow(raw);
    if (!row)
        throw new Error("dimension calibration save did not return a row");
    return row;
}
//# sourceMappingURL=dimensionCalibrationRepository.js.map