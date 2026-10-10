"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureOperationSchema = ensureOperationSchema;
exports.recordInputSetupInDb = recordInputSetupInDb;
exports.recordOutputDataInDb = recordOutputDataInDb;
exports.readOperationTelemetrySummaryFromDb = readOperationTelemetrySummaryFromDb;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const adminDbService_1 = require("./adminDbService");
const config_1 = require("./config");
const schemaReadyByConnection = new Map();
async function ensureOperationSchema(connection) {
    const resolved = connection ?? (await resolveCurrentOperationDbConnection());
    const key = connectionKey(resolved);
    if (!schemaReadyByConnection.has(key)) {
        const promise = (0, adminDbService_1.applyOperationDatabaseSetup)({
            connection: resolved,
            loadSeed: false,
            ensureDatabase: true,
            ensureRole: true,
            schemaFile: resolveSqlFile("001_schema.sql"),
        })
            .then(() => undefined)
            .catch((err) => {
            schemaReadyByConnection.delete(key);
            throw err;
        });
        schemaReadyByConnection.set(key, promise);
    }
    await schemaReadyByConnection.get(key);
}
async function recordInputSetupInDb(record) {
    const raw = await queryStored("SELECT fn_record_input_setup($$payload$$);", record);
    return Number.parseInt(raw.trim() || "0", 10) || 0;
}
async function recordOutputDataInDb(record) {
    const raw = await queryStored("SELECT fn_record_output_data($$payload$$);", record);
    return Number.parseInt(raw.trim() || "0", 10) || 0;
}
async function readOperationTelemetrySummaryFromDb() {
    const raw = await queryStored(`
    SELECT jsonb_build_object(
      'input_setup_count', (SELECT COUNT(*) FROM input_setup),
      'output_data_count', (SELECT COUNT(*) FROM output_data),
      'latest_input_setup', (
        SELECT to_jsonb(t)
          FROM (
            SELECT id, activity_id, start_xy, end_xy, dwell, scale_unit, ev
                 , scan_parameters, update_date
              FROM input_setup
             ORDER BY update_date DESC, id DESC
             LIMIT 1
          ) t
      ),
      'latest_output_data', (
        SELECT to_jsonb(t)
          FROM (
            SELECT id, activity_id, csv_filename, image_filename, description
                 , scan_result, update_date
              FROM output_data
             ORDER BY update_date DESC, id DESC
             LIMIT 1
          ) t
      )
    )::text;
  `);
    const parsed = JSON.parse(raw.trim() || "{}");
    return {
        input_setup_count: Number(parsed.input_setup_count ?? 0) || 0,
        output_data_count: Number(parsed.output_data_count ?? 0) || 0,
        latest_input_setup: normalizeInputSetup(parsed.latest_input_setup),
        latest_output_data: normalizeOutputData(parsed.latest_output_data),
    };
}
async function queryStored(sqlTemplate, payload = null) {
    const connection = await resolveCurrentOperationDbConnection();
    await ensureOperationSchema(connection);
    const payloadSql = jsonbLiteral(payload);
    const sql = `SET search_path TO operation_data, public;\n${sqlTemplate.replace("$$payload$$", payloadSql)}`;
    const out = await (0, adminDbService_1.runPsql)(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
    return out.trim();
}
async function resolveCurrentOperationDbConnection() {
    const info = await readOperationDbConfig();
    return (0, adminDbService_1.pgConnectionFromOperationConfig)(info.data, (0, adminDbService_1.pgConnectionFromOperationRuntimeConfig)());
}
async function readOperationDbConfig() {
    const configuredPath = config_1.config.operationDbConfigPath;
    if (!configuredPath)
        return { data: {} };
    const candidates = [
        configuredPath,
        node_path_1.default.resolve(configuredPath),
        node_path_1.default.resolve(__dirname, "..", "..", "..", "OperationData", "Json", node_path_1.default.basename(configuredPath)),
    ];
    const found = candidates.find((candidate) => node_fs_1.default.existsSync(candidate));
    if (!found)
        return { data: {} };
    const raw = node_fs_1.default.readFileSync(found, "utf8");
    return { data: JSON.parse(raw) };
}
function resolveSqlFile(configuredPath) {
    if (node_path_1.default.isAbsolute(configuredPath) && node_fs_1.default.existsSync(configuredPath))
        return configuredPath;
    const developmentRoot = node_path_1.default.resolve(__dirname, "..", "..", "..");
    const candidates = [
        configuredPath,
        node_path_1.default.join(developmentRoot, "OperationData", "Sql", configuredPath),
        node_path_1.default.join(developmentRoot, configuredPath),
    ];
    const found = candidates.find((candidate) => node_fs_1.default.existsSync(candidate));
    if (!found) {
        throw new Error(`SQL file not found: ${configuredPath}`);
    }
    return found;
}
function jsonbLiteral(value) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}
function normalizeInputSetup(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    const id = Number(row.id ?? 0);
    const activityId = Number(row.activity_id ?? 0);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(activityId) || activityId <= 0)
        return null;
    return {
        id,
        activity_id: activityId,
        start_xy: Number(row.start_xy ?? 0) || 0,
        end_xy: Number(row.end_xy ?? 0) || 0,
        dwell: Number(row.dwell ?? 0) || 0,
        scale_unit: String(row.scale_unit ?? ""),
        ev: Number(row.ev ?? 0) || 0,
        scan_parameters: normalizeObject(row.scan_parameters),
        update_date: String(row.update_date ?? ""),
    };
}
function normalizeOutputData(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    const id = Number(row.id ?? 0);
    const activityId = Number(row.activity_id ?? 0);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(activityId) || activityId <= 0)
        return null;
    return {
        id,
        activity_id: activityId,
        csv_filename: String(row.csv_filename ?? ""),
        image_filename: String(row.image_filename ?? ""),
        description: String(row.description ?? ""),
        scan_result: normalizeObject(row.scan_result),
        update_date: String(row.update_date ?? ""),
    };
}
function normalizeObject(value) {
    return value && typeof value === "object" ? value : {};
}
function connectionKey(connection) {
    return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}
//# sourceMappingURL=operationDataRepository.js.map