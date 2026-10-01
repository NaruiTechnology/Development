"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalibrationRequestError = void 0;
exports.ensureCalibrationCatalog = ensureCalibrationCatalog;
exports.loadCalibrationCatalogSeed = loadCalibrationCatalogSeed;
exports.getEquipmentCalibrationBundle = getEquipmentCalibrationBundle;
exports.listCalibrationGroups = listCalibrationGroups;
exports.getCalibrationTable = getCalibrationTable;
exports.listEquipmentCalibrationHistory = listEquipmentCalibrationHistory;
exports.getCalibrationRevision = getCalibrationRevision;
exports.saveEquipmentCalibration = saveEquipmentCalibration;
exports.restoreCalibrationRevision = restoreCalibrationRevision;
exports.importEquipmentCalibration = importEquipmentCalibration;
exports.updateCalibrationDefinition = updateCalibrationDefinition;
const node_fs_1 = __importDefault(require("node:fs"));
const adminDbService_1 = require("./adminDbService");
const adminDbRepository_1 = require("./adminDbRepository");
/** A failure the database reported in-band ({ok:false,...}); `status` is the HTTP status the API should answer with. */
class CalibrationRequestError extends Error {
    status;
    code;
    details;
    extra;
    constructor(message, status, code, details = [], extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.extra = extra;
        this.name = "CalibrationRequestError";
    }
}
exports.CalibrationRequestError = CalibrationRequestError;
// ------------------------------------------------------------------------------------------ reads
async function ensureCalibrationCatalog() {
    if (!catalogReady) {
        catalogReady = seedIfEmpty().catch((err) => {
            catalogReady = null;
            throw err;
        });
    }
    await catalogReady;
}
let catalogReady = null;
async function seedIfEmpty() {
    const count = await (0, adminDbRepository_1.queryAdminStored)("SELECT count(*) FROM ionbeam_asset.calibration_parameter_definition;", null, "0");
    if (Number.parseInt(count, 10) > 0)
        return;
    await loadCalibrationCatalogSeed();
}
/** Load 004_calibration_seed.sql (idempotent; a re-load keeps human-edited names, see fn_seed_calibration_catalog). */
async function loadCalibrationCatalogSeed() {
    const sql = node_fs_1.default.readFileSync((0, adminDbService_1.resolveSqlFile)("004_calibration_seed.sql"), "utf8");
    await (0, adminDbRepository_1.runAdminSqlScript)(sql);
}
async function getEquipmentCalibrationBundle(equipmentId, equipmentType, query = {}) {
    await ensureCalibrationCatalog();
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_get_equipment_calibration($$payload$$);", { ...query, equipment_id: equipmentId, equipment_type: equipmentType }, "{}");
    return parseBundle(raw);
}
async function listCalibrationGroups(equipmentType, equipmentId, profileName) {
    await ensureCalibrationCatalog();
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_list_calibration_groups($$payload$$);", { equipment_type: equipmentType, equipment_id: equipmentId, profile_name: profileName }, "{}");
    return parseOk(raw, "calibration groups");
}
async function getCalibrationTable(equipmentId, equipmentType, tableCode, profileName) {
    await ensureCalibrationCatalog();
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_get_calibration_table($$payload$$);", { equipment_id: equipmentId, equipment_type: equipmentType, table_code: tableCode, profile_name: profileName }, "{}");
    return parseOk(raw, "calibration table");
}
async function listEquipmentCalibrationHistory(equipmentId, equipmentType, options = {}) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_list_equipment_calibration_history($$payload$$);", { ...options, equipment_id: equipmentId, equipment_type: equipmentType }, "[]");
    const parsed = JSON.parse(raw.trim() || "[]");
    if (!Array.isArray(parsed)) {
        throw new Error("calibration history query returned an invalid response");
    }
    return parsed;
}
async function getCalibrationRevision(equipmentId, equipmentType, revision, profileName) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_get_calibration_revision($$payload$$);", { equipment_id: equipmentId, equipment_type: equipmentType, revision, profile_name: profileName }, "{}");
    return parseOk(raw, "calibration revision");
}
// ------------------------------------------------------------------------------------------ writes
async function saveEquipmentCalibration(payload) {
    await ensureCalibrationCatalog();
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_upsert_equipment_calibration($$payload$$);", payload, "{}");
    return parseBundle(raw);
}
async function restoreCalibrationRevision(payload) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_restore_equipment_calibration_revision($$payload$$);", payload, "{}");
    return parseOk(raw, "calibration restore");
}
async function importEquipmentCalibration(payload) {
    await ensureCalibrationCatalog();
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_import_equipment_calibration($$payload$$);", payload, "{}");
    return parseOk(raw, "calibration import");
}
async function updateCalibrationDefinition(payload) {
    const raw = await (0, adminDbRepository_1.queryAdminStored)("SELECT fn_update_calibration_definition($$payload$$);", payload, "{}");
    return parseOk(raw, "calibration definition").definition;
}
// ------------------------------------------------------------------------------------------ parsing
const STATUS_BY_ERROR = {
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
function parseObject(raw, label) {
    const parsed = JSON.parse(raw.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} query returned an invalid response`);
    }
    return parsed;
}
/** Turns the database's in-band `{ok:false, error, errors?, message?}` into a CalibrationRequestError. */
function throwIfFailed(obj, label) {
    if (obj.ok === false) {
        const code = String(obj.error ?? "failed");
        const details = Array.isArray(obj.errors) ? obj.errors : [];
        const first = details[0];
        const message = String(obj.message ?? first?.message ?? code);
        const { ok: _ok, error: _error, errors: _errors, message: _message, ...extra } = obj;
        // a batch rejected only because of the caller's role is a 403, not a data problem (422)
        const roleOnly = code === "validation_failed" &&
            details.length > 0 &&
            details.every((d) => d.code === "forbidden_role");
        const effective = roleOnly ? "forbidden_role" : code;
        throw new CalibrationRequestError(message, STATUS_BY_ERROR[effective] ?? 400, effective, details, extra);
    }
    if (obj.ok !== true) {
        throw new Error(`${label} query returned an incomplete response`);
    }
}
function parseOk(raw, label) {
    const obj = parseObject(raw, label);
    throwIfFailed(obj, label);
    return obj;
}
function parseBundle(raw) {
    const bundle = parseObject(raw, "calibration");
    throwIfFailed(bundle, "calibration");
    if (!Number.isInteger(bundle.equipment_id) ||
        (bundle.equipment_type !== "FIB" && bundle.equipment_type !== "SEM") ||
        !Array.isArray(bundle.definitions) ||
        !Array.isArray(bundle.values)) {
        throw new Error("calibration query returned an incomplete response");
    }
    return bundle;
}
//# sourceMappingURL=calibrationRepository.js.map