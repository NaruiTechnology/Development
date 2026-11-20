import {
  applyAdminDatabaseSetup,
  isDbConnectivityError,
  pgConnectionFromAdminConfig,
  pgConnectionFromAdminConfigMode,
  pgConnectionFromRuntimeConfig,
  runPsql,
  type PgConnection,
} from "./adminDbService";
import { readAdminWithBackup } from "./configManager";

export interface AdminUser {
  id: number | null;
  login_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  company_name: string;
  site: string;
  role: number;
  is_active: boolean;
  session_lifetime_limit_days: number;
}

export interface Equipment {
  id: number | null;
  name: string;
  model: string;
  serial_number: string;
  site: string;
  equipment_code: string;
  host_computer_model: string;
  motherboard_model: string;
  windows_version: string;
  software_version: string;
  coreco_processing_card: string;
  description: string;
}

export type EquipmentCsvImportRow = Partial<Equipment> & Pick<Equipment, "name">;

export interface EquipmentCsvImportResult {
  equipment: Equipment[];
  added: number;
  updated: number;
}

export interface AllowedHost {
  id: number | null;
  host: string;
}

export type RegisterAdminUserDbResult =
  | { ok: true; user: AdminUser }
  | { ok: false; error: string };

const schemaReadyByConnection = new Map<string, Promise<void>>();
let runtimeDbFallback: { remoteKey: string; error: string; since: number; simulatedUntil?: number } | null = null;
const ROLE_ADMIN = 3;
const ROLE_AUDIT = 4;

export interface AdminDbRuntimeStatus {
  configured_mode: "remote" | "local";
  active_mode: "remote" | "local";
  fallback_active: boolean;
  fallback_error: string | null;
  local_reachable: boolean;
  simulated: boolean;
}

export async function ensureAdminSchema(connection?: PgConnection): Promise<void> {
  const resolved = connection ?? (await resolveCurrentAdminDbConnection());
  const key = connectionKey(resolved);
  if (!schemaReadyByConnection.has(key)) {
    const promise = applyAdminDatabaseSetup({
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

export async function recordAdminSessionInDb(
  user: AdminUser,
  clientMachineName: string,
  selectedSite: string,
): Promise<void> {
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

export async function isAdminSessionExpiredInDb(userId: number, lifetimeDays: number): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0) return true;
  const out = await queryStored(
    "SELECT fn_is_admin_session_expired($$payload$$);",
    { user_id: userId, lifetime_days: lifetimeDays },
    "false",
  );
  return out.trim() === "true";
}

export async function recordActivityInDb(
  userId: number,
  equipmentId: number | null,
  activityType: string,
  lifetimeDays: number,
): Promise<number> {
  const raw = await queryStored("SELECT fn_record_admin_activity($$payload$$);", {
    user_id: userId,
    equipment_id: equipmentId,
    activity_type: activityType,
    session_lifetime_limit_days: lifetimeDays,
  });
  return Number.parseInt(raw.trim() || "0", 10) || 0;
}

export async function adminActivityExistsInDb(activityId: number): Promise<boolean> {
  if (!Number.isInteger(activityId) || activityId <= 0) return false;
  const raw = await queryStored(
    `SELECT 1
       FROM activity
      WHERE id = ${activityId};`,
    null,
    "0",
  );
  return raw.trim() === "1";
}

export async function buildActivityReportFromDb(
  userIds: number[],
  days: number,
  equipmentId: number | null = null,
): Promise<Record<string, unknown>> {
  const raw = await queryStored("SELECT fn_admin_activity_report($$payload$$);", {
    user_ids: userIds,
    days,
    equipment_id: equipmentId,
  });
  const parsed = JSON.parse(raw.trim() || "{}") as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export async function dedupeActivityRowsFromDb(): Promise<number> {
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

export async function listEquipmentFromDb(): Promise<Equipment[]> {
  const raw = await queryStored("SELECT fn_list_equipment();");
  return parseArray(raw) as Equipment[];
}

export async function exportEquipmentCsvFromDb(): Promise<string> {
  return queryStored("SELECT fn_export_equipment_csv();");
}

export async function importEquipmentCsvToDb(rows: EquipmentCsvImportRow[]): Promise<EquipmentCsvImportResult> {
  const raw = await queryStored("SELECT fn_import_equipment_csv($$payload$$);", rows);
  const parsed = JSON.parse(raw || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fn_import_equipment_csv returned an invalid response");
  }
  const result = parsed as Record<string, unknown>;
  if (result.ok !== true || !Array.isArray(result.equipment)) {
    throw new Error("fn_import_equipment_csv returned an invalid result");
  }
  if (!Number.isInteger(result.added) || !Number.isInteger(result.updated)) {
    throw new Error("fn_import_equipment_csv returned invalid import counts");
  }
  return {
    equipment: result.equipment as Equipment[],
    added: result.added as number,
    updated: result.updated as number,
  };
}

export async function listAllowedHostsFromDb(): Promise<string[]> {
  const raw = await queryStored("SELECT fn_list_hosts();");
  return parseStringArray(raw);
}

export async function syncEquipmentToDb(equipmentRows: Equipment[]): Promise<void> {
  const rows = equipmentRows.filter((equipment) => equipment.name.trim());
  if (rows.length === 0) return;
  await executeStored("SELECT fn_upsert_equipment($$payload$$);", rows);
}

export async function replaceAllowedHostsInDb(hosts: string[]): Promise<void> {
  await executeStored("SELECT fn_replace_hosts($$payload$$);", normalizeAllowedHosts(hosts));
}

export async function findAdminUserInDb(loginOrEmail: string): Promise<AdminUser | null> {
  const login = loginOrEmail.trim();
  if (!login) return null;
  const raw = await queryStored("SELECT fn_find_admin_user($$payload$$);", { login_or_email: login });
  return parseFirstUser(raw);
}

export async function findAdminUserInDbById(id: number): Promise<AdminUser | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const raw = await queryStored("SELECT fn_find_admin_user_by_id($$payload$$);", { id });
  return parseFirstUser(raw);
}

export async function listAdminUsersFromDb(): Promise<AdminUser[]> {
  const raw = await queryStored("SELECT fn_list_admin_users();");
  return parseArray(raw) as AdminUser[];
}

export async function syncAdminUsersToDb(users: AdminUser[]): Promise<void> {
  const rows = users.filter((user) => user.login_name.trim() && user.email.trim());
  if (rows.length === 0) return;
  await executeStored("SELECT fn_upsert_admin_users($$payload$$);", rows);
}

export async function registerAdminUserInDb(user: AdminUser): Promise<RegisterAdminUserDbResult> {
  const raw = await queryStored("SELECT fn_register_admin_user($$payload$$);", user);
  const parsed = JSON.parse(raw.trim() || "{}") as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("fn_register_admin_user returned an invalid response");
  }
  const result = parsed as Record<string, unknown>;
  if (result.ok === false) {
    return { ok: false, error: String(result.error ?? "registration failed") };
  }
  if (result.ok !== true) {
    throw new Error("fn_register_admin_user returned an invalid status");
  }
  return { ok: true, user: result.user as AdminUser };
}

async function executeStored(sqlTemplate: string, payload: unknown = null): Promise<void> {
  await queryStored(sqlTemplate, payload);
}

async function queryStored(sqlTemplate: string, payload: unknown = null, fallback = ""): Promise<string> {
  const primary = await resolveCurrentAdminDbConnection();
  const localFallback = pgConnectionFromRuntimeConfig();
  const targets = connectionKey(primary) === connectionKey(localFallback)
    ? [primary]
    : [primary, localFallback];
  const payloadSql = jsonbLiteral(payload);
  // A replacer *function*: String.replace() would otherwise expand "$&", "$'" ... sequences found inside the JSON payload.
  const sql = `SET search_path TO iobeam_admin, ionbeam_asset, public;\n${sqlTemplate.replace("$$payload$$", () => payloadSql)}`;
  for (let index = 0; index < targets.length; index += 1) {
    const connection = targets[index];
    try {
      await ensureAdminSchema(connection);
      const out = await runPsql(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
      if (index === 0) noteRemoteAvailable(connection);
      if (index > 0) {
        await activateLocalFallback(targets[0], "Remote database connection is unavailable.", connection);
        console.warn(`[admin-db] remote connection failed; using local fallback at ${connection.host}`);
      }
      return out.trim() || fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (index === 0 && targets.length > 1 && isDbConnectivityError(message)) {
        await activateLocalFallback(connection, message, localFallback);
        continue;
      }
      throw error;
    }
  }
  return fallback;
}

/** Run a whole SQL script (e.g. a seed file) against the admin database. */
export async function runAdminSqlScript(sql: string): Promise<void> {
  const primary = await resolveCurrentAdminDbConnection();
  const localFallback = pgConnectionFromRuntimeConfig();
  const targets = connectionKey(primary) === connectionKey(localFallback)
    ? [primary]
    : [primary, localFallback];
  for (let index = 0; index < targets.length; index += 1) {
    const connection = targets[index];
    try {
      await ensureAdminSchema(connection);
      await runPsql(["-q", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
      if (index === 0) noteRemoteAvailable(connection);
      if (index > 0) {
        await activateLocalFallback(targets[0], "Remote database connection is unavailable.", connection);
        console.warn(`[admin-db] remote connection failed; using local fallback at ${connection.host}`);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (index === 0 && targets.length > 1 && isDbConnectivityError(message)) {
        await activateLocalFallback(connection, message, localFallback);
        continue;
      }
      throw error;
    }
  }
}

export async function queryAdminStored(
  sqlTemplate: string,
  payload: unknown = null,
  fallback = "",
): Promise<string> {
  return queryStored(sqlTemplate, payload, fallback);
}

function parseFirstUser(raw: string): AdminUser | null {
  const rows = parseArray(raw);
  return rows[0] ? (rows[0] as AdminUser) : null;
}

function parseArray(raw: string): unknown[] {
  const parsed = JSON.parse(raw.trim() || "[]") as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function parseStringArray(raw: string): string[] {
  return parseArray(raw)
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts) {
    const value = String(host ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.length > 0 ? normalized : ["localhost", "ion.o-0.top"];
}

function jsonbLiteral(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

export async function resolveCurrentAdminDbConnection(): Promise<PgConnection> {
  const info = await readAdminWithBackup();
  const local = pgConnectionFromRuntimeConfig();
  const mode = adminDbConfiguredMode(info.data);
  if (mode === "local") {
    runtimeDbFallback = null;
    return local;
  }
  const remote = pgConnectionFromAdminConfigMode(info.data, local);
  if (connectionKey(remote) === connectionKey(local)) return local;
  if (runtimeDbFallback && runtimeDbFallback.remoteKey !== connectionKey(remote)) runtimeDbFallback = null;
  return runtimeDbFallback ? local : remote;
}

/** Force the normal failover state for a short, in-memory UI verification case. */
export async function simulateAdminDbRemoteUnavailable(durationMs = 30_000): Promise<AdminDbRuntimeStatus> {
  const info = await readAdminWithBackup();
  const local = pgConnectionFromRuntimeConfig();
  const remote = pgConnectionFromAdminConfig(info.data, local);
  const error = "Remote connection intentionally marked unavailable for verification.";
  await activateLocalFallback(remote, error, local);
  runtimeDbFallback = { remoteKey: connectionKey(remote), error, since: Date.now(),
    simulatedUntil: Date.now() + Math.max(5_000, Math.min(120_000, durationMs)) };
  let localReachable = false;
  try {
    await runPsql(["-Atq", "-c", "SELECT 1"], local.database,
      undefined, { ...local, commandTimeoutMs: Math.min(local.commandTimeoutMs, 4_000) });
    localReachable = true;
  } catch { /* the UI still reports the selected fallback and its reachability */ }
  return {
    configured_mode: adminDbConfiguredMode(info.data),
    active_mode: "local",
    fallback_active: true,
    fallback_error: error,
    local_reachable: localReachable,
    simulated: true,
  };
}

/** Probe the configured remote and expose the effective runtime connection. */
export async function getAdminDbRuntimeStatus(): Promise<AdminDbRuntimeStatus> {
  const info = await readAdminWithBackup();
  const local = pgConnectionFromRuntimeConfig();
  const configuredMode = adminDbConfiguredMode(info.data);
  if (configuredMode === "local") {
    runtimeDbFallback = null;
    let localReachable = false;
    try {
      await runPsql(["-Atq", "-c", "SELECT 1"], local.database,
        undefined, { ...local, commandTimeoutMs: Math.min(local.commandTimeoutMs, 4_000) });
      localReachable = true;
    } catch { /* report local unavailable */ }
    return { configured_mode: "local", active_mode: "local", fallback_active: false,
      fallback_error: null, local_reachable: localReachable, simulated: false };
  }

  const remote = pgConnectionFromAdminConfig(info.data, local);
  if (connectionKey(remote) === connectionKey(local)) {
    return { configured_mode: "remote", active_mode: "local", fallback_active: false,
      fallback_error: null, local_reachable: true, simulated: false };
  }
  if (runtimeDbFallback?.remoteKey === connectionKey(remote)
      && runtimeDbFallback.simulatedUntil && runtimeDbFallback.simulatedUntil > Date.now()) {
    return { configured_mode: "remote", active_mode: "local", fallback_active: true,
      fallback_error: runtimeDbFallback.error, local_reachable: true, simulated: true };
  }
  if (runtimeDbFallback?.simulatedUntil && runtimeDbFallback.simulatedUntil <= Date.now()) runtimeDbFallback = null;
  try {
    await runPsql(["-Atq", "-c", "SELECT 1"], remote.database,
      undefined, { ...remote, commandTimeoutMs: Math.min(remote.commandTimeoutMs, 4_000) });
    runtimeDbFallback = null;
    return { configured_mode: "remote", active_mode: "remote", fallback_active: false,
      fallback_error: null, local_reachable: true, simulated: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isDbConnectivityError(message)) {
      return { configured_mode: "remote", active_mode: runtimeDbFallback ? "local" : "remote",
        fallback_active: runtimeDbFallback !== null, fallback_error: runtimeDbFallback?.error ?? message,
        local_reachable: runtimeDbFallback !== null, simulated: Boolean(runtimeDbFallback?.simulatedUntil) };
    }
    await activateLocalFallback(remote, message, local);
    let localReachable = false;
    try {
      await runPsql(["-Atq", "-c", "SELECT 1"], local.database,
        undefined, { ...local, commandTimeoutMs: Math.min(local.commandTimeoutMs, 4_000) });
      localReachable = true;
    } catch { /* report local unavailable */ }
    return { configured_mode: "remote", active_mode: "local", fallback_active: true,
      fallback_error: message, local_reachable: localReachable, simulated: false };
  }
}

function adminDbConfiguredMode(data: unknown): "remote" | "local" {
  const root = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const database = root.Database && typeof root.Database === "object"
    ? root.Database as Record<string, unknown> : {};
  return String(database.ConnectionMode ?? database.connectionMode ?? "remote").toLowerCase() === "local"
    ? "local" : "remote";
}

async function activateLocalFallback(remote: PgConnection, error: string, local = pgConnectionFromRuntimeConfig()): Promise<void> {
  const remoteKey = connectionKey(remote);
  const isNewFallback = runtimeDbFallback?.remoteKey !== remoteKey;
  runtimeDbFallback = { remoteKey, error, since: Date.now() };
  if (!isNewFallback) return;
  console.warn(`[admin-db] remote ${remote.host}:${remote.port} is unavailable; switching to local database: ${error}`);
  try {
    await ensureAdminSchema(local);
    const sql = `UPDATE iobeam_admin."user" AS u
      SET role = GREATEST(u.role, ${ROLE_ADMIN}, ${ROLE_AUDIT})
      FROM iobeam_admin.auditor AS a
      WHERE lower(btrim(u.email)) = lower(btrim(a.email))
         OR lower(btrim(u.login_name)) = lower(btrim(a.user_name));`;
    await runPsql(["-v", "ON_ERROR_STOP=1"], local.database, sql, local);
  } catch (grantError) {
    console.error("[admin-db] could not grant local admin access to auditor accounts during failover:", grantError);
  }
}

function noteRemoteAvailable(connection: PgConnection): void {
  if (runtimeDbFallback?.remoteKey === connectionKey(connection)) runtimeDbFallback = null;
}

function connectionKey(connection: PgConnection): string {
  return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}

/** Strict result handling with the same local fallback used by other admin DB operations. */
export async function queryAdminStoredStrict(sqlTemplate: string, payload: unknown = null): Promise<string> {
  const primary = await resolveCurrentAdminDbConnection();
  const localFallback = pgConnectionFromRuntimeConfig();
  const targets = connectionKey(primary) === connectionKey(localFallback)
    ? [primary]
    : [primary, localFallback];
  const sql = sqlTemplate.replaceAll("$$payload$$", () => jsonbLiteral(payload));
  for (let index = 0; index < targets.length; index += 1) {
    const connection = targets[index];
    try {
      await ensureAdminSchema(connection);
      const result = await runPsql(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
      if (index === 0) noteRemoteAvailable(connection);
      if (index > 0) {
        await activateLocalFallback(targets[0], "Remote database connection is unavailable.", connection);
        console.warn(`[admin-db] remote connection failed; using local fallback at ${connection.host}`);
      }
      return result.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (index === 0 && targets.length > 1 && isDbConnectivityError(message)) {
        await activateLocalFallback(connection, message, localFallback);
        continue;
      }
      throw error;
    }
  }
  return "";
}
