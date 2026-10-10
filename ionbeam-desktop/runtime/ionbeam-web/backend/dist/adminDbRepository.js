"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAdminSchema = ensureAdminSchema;
exports.recordAdminSessionInDb = recordAdminSessionInDb;
exports.isAdminSessionExpiredInDb = isAdminSessionExpiredInDb;
exports.recordActivityInDb = recordActivityInDb;
exports.adminActivityExistsInDb = adminActivityExistsInDb;
exports.buildActivityReportFromDb = buildActivityReportFromDb;
exports.dedupeActivityRowsFromDb = dedupeActivityRowsFromDb;
exports.listEquipmentFromDb = listEquipmentFromDb;
exports.listAllowedHostsFromDb = listAllowedHostsFromDb;
exports.syncEquipmentToDb = syncEquipmentToDb;
exports.replaceAllowedHostsInDb = replaceAllowedHostsInDb;
exports.findAdminUserInDb = findAdminUserInDb;
exports.findAdminUserInDbById = findAdminUserInDbById;
exports.listAdminUsersFromDb = listAdminUsersFromDb;
exports.syncAdminUsersToDb = syncAdminUsersToDb;
exports.registerAdminUserInDb = registerAdminUserInDb;
exports.runAdminSqlScript = runAdminSqlScript;
exports.queryAdminStored = queryAdminStored;
const adminDbService_1 = require("./adminDbService");
const configManager_1 = require("./configManager");
const schemaReadyByConnection = new Map();
async function ensureAdminSchema(connection) {
    const resolved = connection ?? (await resolveCurrentAdminDbConnection());
    const key = connectionKey(resolved);
    if (!schemaReadyByConnection.has(key)) {
        const promise = (0, adminDbService_1.applyAdminDatabaseSetup)({
            connection: resolved,
            loadSeed: false,
            ensureDatabase: false,
            ensureRole: false,
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
async function recordAdminSessionInDb(user, clientMachineName, selectedSite) {
    if (!Number.isInteger(user.id) || (user.id ?? 0) <= 0) {
        throw new Error("cannot record session for an admin user without a database id");
    }
    await executeStored("SELECT fn_record_admin_session($$payload$$);", {
        user_id: user.id,
        login_name: user.login_name,
        client_machine_name: clientMachineName,
        site: selectedSite,
    });
}
async function isAdminSessionExpiredInDb(userId, lifetimeDays) {
    if (!Number.isInteger(userId) || userId <= 0)
        return true;
    const out = await queryStored("SELECT fn_is_admin_session_expired($$payload$$);", { user_id: userId, lifetime_days: lifetimeDays }, "false");
    return out.trim() === "true";
}
async function recordActivityInDb(userId, equipmentId, activityType, lifetimeDays) {
    const raw = await queryStored("SELECT fn_record_admin_activity($$payload$$);", {
        user_id: userId,
        equipment_id: equipmentId,
        activity_type: activityType,
        session_lifetime_limit_days: lifetimeDays,
    });
    return Number.parseInt(raw.trim() || "0", 10) || 0;
}
async function adminActivityExistsInDb(activityId) {
    if (!Number.isInteger(activityId) || activityId <= 0)
        return false;
    const raw = await queryStored(`SELECT 1
       FROM activity
      WHERE id = ${activityId};`, null, "0");
    return raw.trim() === "1";
}
async function buildActivityReportFromDb(userIds, days, equipmentId = null) {
    const raw = await queryStored("SELECT fn_admin_activity_report($$payload$$);", {
        user_ids: userIds,
        days,
        equipment_id: equipmentId,
    });
    const parsed = JSON.parse(raw.trim() || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
}
async function dedupeActivityRowsFromDb() {
    const raw = await queryStored(`
    WITH classified AS (
      SELECT
        id,
        user_id,
        equipment_id,
        date,
        CASE
          WHEN upper(btrim(activity_type::text)) LIKE '%RASTER%' THEN 'raster'
          WHEN upper(btrim(activity_type::text)) LIKE '%VECTOR%'
            OR upper(btrim(activity_type::text)) LIKE '%VECTER%' THEN 'vector'
          ELSE 'other'
        END AS scan_kind,
        row_number() OVER (
          PARTITION BY
            user_id,
            equipment_id,
            CASE
              WHEN upper(btrim(activity_type::text)) LIKE '%RASTER%' THEN 'raster'
              WHEN upper(btrim(activity_type::text)) LIKE '%VECTOR%'
                OR upper(btrim(activity_type::text)) LIKE '%VECTER%' THEN 'vector'
              ELSE 'other'
            END,
            date_trunc('second', date)
          ORDER BY date ASC, id ASC
        ) AS rn
      FROM activity
    ),
    deleted AS (
      DELETE FROM activity a
      USING classified c
      WHERE a.id = c.id
        AND c.rn > 1
      RETURNING a.id
    )
    SELECT COUNT(*)::int FROM deleted;
  `);
    return Number.parseInt(raw.trim() || "0", 10) || 0;
}
async function listEquipmentFromDb() {
    const raw = await queryStored("SELECT fn_list_equipment();");
    return parseArray(raw);
}
async function listAllowedHostsFromDb() {
    const raw = await queryStored("SELECT fn_list_hosts();");
    return parseStringArray(raw);
}
async function syncEquipmentToDb(equipmentRows) {
    const rows = equipmentRows.filter((equipment) => equipment.name.trim() && equipment.serial_number.trim());
    if (rows.length === 0)
        return;
    await executeStored("SELECT fn_upsert_equipment($$payload$$);", rows);
}
async function replaceAllowedHostsInDb(hosts) {
    await executeStored("SELECT fn_replace_hosts($$payload$$);", normalizeAllowedHosts(hosts));
}
async function findAdminUserInDb(loginOrEmail) {
    const login = loginOrEmail.trim();
    if (!login)
        return null;
    const raw = await queryStored("SELECT fn_find_admin_user($$payload$$);", { login_or_email: login });
    return parseFirstUser(raw);
}
async function findAdminUserInDbById(id) {
    if (!Number.isInteger(id) || id <= 0)
        return null;
    const raw = await queryStored("SELECT fn_find_admin_user_by_id($$payload$$);", { id });
    return parseFirstUser(raw);
}
async function listAdminUsersFromDb() {
    const raw = await queryStored("SELECT fn_list_admin_users();");
    return parseArray(raw);
}
async function syncAdminUsersToDb(users) {
    const rows = users.filter((user) => user.login_name.trim() && user.email.trim());
    if (rows.length === 0)
        return;
    await executeStored("SELECT fn_upsert_admin_users($$payload$$);", rows);
}
async function registerAdminUserInDb(user) {
    const raw = await queryStored("SELECT fn_register_admin_user($$payload$$);", user);
    const parsed = JSON.parse(raw.trim() || "{}");
    if (!parsed || typeof parsed !== "object") {
        throw new Error("fn_register_admin_user returned an invalid response");
    }
    const result = parsed;
    if (result.ok === false) {
        return { ok: false, error: String(result.error ?? "registration failed") };
    }
    if (result.ok !== true) {
        throw new Error("fn_register_admin_user returned an invalid status");
    }
    return { ok: true, user: result.user };
}
async function executeStored(sqlTemplate, payload = null) {
    await queryStored(sqlTemplate, payload);
}
async function queryStored(sqlTemplate, payload = null, fallback = "") {
    const connection = await resolveCurrentAdminDbConnection();
    await ensureAdminSchema(connection);
    const payloadSql = jsonbLiteral(payload);
    // A replacer *function*: String.replace() would otherwise expand "$&", "$'" ... sequences found inside the JSON payload.
    const sql = `SET search_path TO iobeam_admin, ionbeam_asset, public;\n${sqlTemplate.replace("$$payload$$", () => payloadSql)}`;
    const out = await (0, adminDbService_1.runPsql)(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
    return out.trim() || fallback;
}
/** Run a whole SQL script (e.g. a seed file) against the admin database. */
async function runAdminSqlScript(sql) {
    const connection = await resolveCurrentAdminDbConnection();
    await ensureAdminSchema(connection);
    await (0, adminDbService_1.runPsql)(["-q", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
}
async function queryAdminStored(sqlTemplate, payload = null, fallback = "") {
    return queryStored(sqlTemplate, payload, fallback);
}
function parseFirstUser(raw) {
    const rows = parseArray(raw);
    return rows[0] ? rows[0] : null;
}
function parseArray(raw) {
    const parsed = JSON.parse(raw.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [];
}
function parseStringArray(raw) {
    return parseArray(raw)
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0);
}
function normalizeAllowedHosts(hosts) {
    const seen = new Set();
    const normalized = [];
    for (const host of hosts) {
        const value = String(host ?? "").trim().toLowerCase();
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        normalized.push(value);
    }
    return normalized.length > 0 ? normalized : ["localhost", "ion.o-0.top"];
}
function jsonbLiteral(value) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}
async function resolveCurrentAdminDbConnection() {
    const info = await (0, configManager_1.readAdminWithBackup)();
    return (0, adminDbService_1.pgConnectionFromAdminConfig)(info.data, (0, adminDbService_1.pgConnectionFromRuntimeConfig)());
}
function connectionKey(connection) {
    return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}
//# sourceMappingURL=adminDbRepository.js.map