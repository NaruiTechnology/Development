import {
  applyAdminDatabaseSetup,
  pgConnectionFromAdminConfig,
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
  description: string;
}

export interface AllowedHost {
  id: number | null;
  host: string;
}

export type RegisterAdminUserDbResult =
  | { ok: true; user: AdminUser }
  | { ok: false; error: string };

const schemaReadyByConnection = new Map<string, Promise<void>>();

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

export async function listAllowedHostsFromDb(): Promise<string[]> {
  const raw = await queryStored("SELECT fn_list_hosts();");
  return parseStringArray(raw);
}

export async function syncEquipmentToDb(equipmentRows: Equipment[]): Promise<void> {
  const rows = equipmentRows.filter((equipment) => equipment.name.trim() && equipment.serial_number.trim());
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
  const connection = await resolveCurrentAdminDbConnection();
  await ensureAdminSchema(connection);
  const payloadSql = jsonbLiteral(payload);
  const sql = `SET search_path TO iobeam_admin, ionbeam_asset, public;\n${sqlTemplate.replace("$$payload$$", payloadSql)}`;
  const out = await runPsql(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
  return out.trim() || fallback;
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

async function resolveCurrentAdminDbConnection(): Promise<PgConnection> {
  const info = await readAdminWithBackup();
  return pgConnectionFromAdminConfig(info.data, pgConnectionFromRuntimeConfig());
}

function connectionKey(connection: PgConnection): string {
  return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}
