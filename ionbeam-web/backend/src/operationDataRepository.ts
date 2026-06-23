import fs from "node:fs";
import path from "node:path";

import {
  applyOperationDatabaseSetup,
  pgConnectionFromOperationConfig,
  pgConnectionFromOperationRuntimeConfig,
  runPsql,
  type PgConnection,
} from "./adminDbService";
import { config } from "./config";

export interface ScanInputSetupRecord {
  activity_id: number;
  start_xy: number;
  end_xy: number;
  dwell: number;
  scale_unit: string;
  ev: number;
  scan_parameters: Record<string, unknown>;
}

export interface ScanOutputDataRecord {
  activity_id: number;
  csv_filename: string;
  image_filename: string;
  description: string;
  scan_result: Record<string, unknown>;
}

export interface OperationTelemetrySummary {
  input_setup_count: number;
  output_data_count: number;
  latest_input_setup: {
    id: number;
    activity_id: number;
    start_xy: number;
    end_xy: number;
    dwell: number;
    scale_unit: string;
    ev: number;
    scan_parameters: Record<string, unknown>;
    update_date: string;
  } | null;
  latest_output_data: {
    id: number;
    activity_id: number;
    csv_filename: string;
    image_filename: string;
    description: string;
    scan_result: Record<string, unknown>;
    update_date: string;
  } | null;
}

const schemaReadyByConnection = new Map<string, Promise<void>>();

export async function ensureOperationSchema(connection?: PgConnection): Promise<void> {
  const resolved = connection ?? (await resolveCurrentOperationDbConnection());
  const key = connectionKey(resolved);
  if (!schemaReadyByConnection.has(key)) {
    const promise = applyOperationDatabaseSetup({
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

export async function recordInputSetupInDb(record: ScanInputSetupRecord): Promise<number> {
  const raw = await queryStored("SELECT fn_record_input_setup($$payload$$);", record);
  return Number.parseInt(raw.trim() || "0", 10) || 0;
}

export async function recordOutputDataInDb(record: ScanOutputDataRecord): Promise<number> {
  const raw = await queryStored("SELECT fn_record_output_data($$payload$$);", record);
  return Number.parseInt(raw.trim() || "0", 10) || 0;
}

export async function readOperationTelemetrySummaryFromDb(): Promise<OperationTelemetrySummary> {
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
  const parsed = JSON.parse(raw.trim() || "{}") as Record<string, unknown>;
  return {
    input_setup_count: Number(parsed.input_setup_count ?? 0) || 0,
    output_data_count: Number(parsed.output_data_count ?? 0) || 0,
    latest_input_setup: normalizeInputSetup(parsed.latest_input_setup),
    latest_output_data: normalizeOutputData(parsed.latest_output_data),
  };
}

async function queryStored(sqlTemplate: string, payload: unknown = null): Promise<string> {
  const connection = await resolveCurrentOperationDbConnection();
  await ensureOperationSchema(connection);
  const payloadSql = jsonbLiteral(payload);
  const sql = `SET search_path TO operation_data, public;\n${sqlTemplate.replace("$$payload$$", payloadSql)}`;
  const out = await runPsql(["-Atq", "-v", "ON_ERROR_STOP=1"], connection.database, sql, connection);
  return out.trim();
}

async function resolveCurrentOperationDbConnection(): Promise<PgConnection> {
  const info = await readOperationDbConfig();
  return pgConnectionFromOperationConfig(info.data, pgConnectionFromOperationRuntimeConfig());
}

async function readOperationDbConfig(): Promise<{ data: unknown }> {
  const configuredPath = config.operationDbConfigPath;
  if (!configuredPath) return { data: {} };
  const candidates = [
    configuredPath,
    path.resolve(configuredPath),
    path.resolve(__dirname, "..", "..", "..", "OperationData", "Json", path.basename(configuredPath)),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return { data: {} };
  const raw = fs.readFileSync(found, "utf8");
  return { data: JSON.parse(raw) as unknown };
}

function resolveSqlFile(configuredPath: string): string {
  if (path.isAbsolute(configuredPath) && fs.existsSync(configuredPath)) return configuredPath;
  const developmentRoot = path.resolve(__dirname, "..", "..", "..");
  const candidates = [
    configuredPath,
    path.join(developmentRoot, "OperationData", "Sql", configuredPath),
    path.join(developmentRoot, configuredPath),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`SQL file not found: ${configuredPath}`);
  }
  return found;
}

function jsonbLiteral(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function normalizeInputSetup(value: unknown): OperationTelemetrySummary["latest_input_setup"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id ?? 0);
  const activityId = Number(row.activity_id ?? 0);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(activityId) || activityId <= 0) return null;
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

function normalizeOutputData(value: unknown): OperationTelemetrySummary["latest_output_data"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = Number(row.id ?? 0);
  const activityId = Number(row.activity_id ?? 0);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(activityId) || activityId <= 0) return null;
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

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function connectionKey(connection: PgConnection): string {
  return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}
