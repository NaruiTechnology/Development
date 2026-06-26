/**
 * Environment loader. Centralised so the rest of the backend can read a
 * single typed object instead of poking process.env directly.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function currentLogin(): string {
  try {
    const username = os.userInfo().username.trim();
    if (username) return username;
  } catch {
    // Fall through to environment-based fallbacks below.
  }
  return (
    process.env.USER?.trim() ||
    process.env.LOGNAME?.trim() ||
    process.env.USERNAME?.trim() ||
    "postgres"
  );
}

export interface Config {
  port: number;
  proxyTargetHttp: string;
  proxyTargetWs: string;
  glasgowToken: string | null;
  mock: boolean;
  mobilityOnly: boolean;
  staticDir: string;
  configPath: string;
  adminConfigPath: string;
  restartCmd: string;
  restartBackendAfterGlasgow: boolean;
  backendRestartCmd: string | null;
  configStrict: boolean;
  adminDbConfigPath: string;
  adminDbHost: string;
  adminDbPort: number;
  adminDbName: string;
  adminDbUser: string;
  adminDbPassword: string | null;
  adminDbSslMode: string | null;
  adminDbCommandTimeoutMs: number;
  operationDbConfigPath: string;
  operationDbHost: string;
  operationDbPort: number;
  operationDbName: string;
  operationDbUser: string;
  operationDbPassword: string | null;
  operationDbSslMode: string | null;
  operationDbCommandTimeoutMs: number;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFromNumber: string | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
}

const BACKEND_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..", "..");
const DEFAULT_CONFIG_PATH = path.join(
  REPO_ROOT,
  "GlasgowDataIO",
  "Json",
  "streamData.json"
);
const DEPLOYMENT_CONFIG_PATH = path.join(
  REPO_ROOT,
  "Development",
  "GlasgowDataIO",
  "Json",
  "streamData.json"
);
const DEFAULT_ADMIN_CONFIG_PATH = path.join(
  REPO_ROOT,
  "IobeamAdmin",
  "Json",
  "IobeamAdmin.json"
);
const DEPLOYMENT_ADMIN_CONFIG_PATH = path.join(
  REPO_ROOT,
  "Development",
  "IobeamAdmin",
  "Json",
  "IobeamAdmin.json"
);
const DEFAULT_ADMIN_DB_CONFIG_PATH = path.join(
  REPO_ROOT,
  "IobeamAdmin",
  "Json",
  "IobeamAdminDb.json"
);
const DEPLOYMENT_ADMIN_DB_CONFIG_PATH = path.join(
  REPO_ROOT,
  "Development",
  "IobeamAdmin",
  "Json",
  "IobeamAdminDb.json"
);
const DEFAULT_OPERATION_DB_CONFIG_PATH = path.join(
  REPO_ROOT,
  "OperationData",
  "Json",
  "OperationDataDb.json"
);
const DEPLOYMENT_OPERATION_DB_CONFIG_PATH = path.join(
  REPO_ROOT,
  "Development",
  "OperationData",
  "Json",
  "OperationDataDb.json"
);
const RESTART_SCRIPT = path.join(
  BACKEND_ROOT,
  "scripts",
  process.platform === "win32"
    ? "restart-glasgow-service.ps1"
    : "restart-glasgow-service.sh"
);
const BACKEND_RESTART_SCRIPT = path.join(
  BACKEND_ROOT,
  "scripts",
  process.platform === "win32"
    ? "restart-ionbeam-backend.ps1"
    : "restart-ionbeam-backend.sh"
);
const DEFAULT_RESTART_CMD =
  process.platform === "win32"
    ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${RESTART_SCRIPT}"`
    : RESTART_SCRIPT;
const DEFAULT_BACKEND_RESTART_CMD =
  process.platform === "win32"
    ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${BACKEND_RESTART_SCRIPT}"`
    : BACKEND_RESTART_SCRIPT;
const DEFAULT_RESTART_BACKEND_AFTER_GLASGOW = process.platform !== "win32";

function hasStreamDataTail(p: string): boolean {
  const parts = path.normalize(p).split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-3).map((part) => part.toLowerCase());
  return tail.join("/") === "glasgowdataio/json/streamdata.json";
}

function resolveConfigPath(raw: string | undefined): string {
  const candidate = raw?.trim();
  if (!candidate) return firstExistingConfigPath([DEPLOYMENT_CONFIG_PATH, DEFAULT_CONFIG_PATH]);
  const resolvedCandidate = path.resolve(candidate);
  if (hasStreamDataTail(resolvedCandidate)) {
    return firstExistingConfigPath([
      siblingDevelopmentConfigPath(resolvedCandidate),
      DEPLOYMENT_CONFIG_PATH,
      resolvedCandidate,
      DEFAULT_CONFIG_PATH,
    ], resolvedCandidate);
  }
  if (fs.existsSync(resolvedCandidate)) return resolvedCandidate;
  return resolvedCandidate;
}

function resolveAdminConfigPath(raw: string | undefined): string {
  const candidate = raw?.trim();
  if (!candidate) {
    return firstExistingConfigPath([
      DEPLOYMENT_ADMIN_CONFIG_PATH,
      DEFAULT_ADMIN_CONFIG_PATH,
    ]);
  }
  const resolvedCandidate = path.resolve(candidate);
  if (fs.existsSync(resolvedCandidate)) return resolvedCandidate;
  return resolvedCandidate;
}

function firstExistingConfigPath(paths: Array<string | null>, fallback?: string): string {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return fallback ?? path.resolve(paths.find(Boolean) ?? DEFAULT_CONFIG_PATH);
}

function siblingDevelopmentConfigPath(streamDataPath: string): string {
  const jsonDir = path.dirname(streamDataPath);
  const glasgowDataIoDir = path.dirname(jsonDir);
  const deployRoot = path.dirname(glasgowDataIoDir);
  return path.join(
    deployRoot,
    "Development",
    "GlasgowDataIO",
    "Json",
    "streamData.json"
  );
}

interface AdminDbDefaults {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
  sslMode: string | null;
  commandTimeoutMs: number;
}

const adminDbConfigPath =
  process.env.IOBEAM_ADMIN_DB_CONFIG?.trim() ||
  firstExistingConfigPath([
    DEPLOYMENT_ADMIN_DB_CONFIG_PATH,
    DEFAULT_ADMIN_DB_CONFIG_PATH,
  ], DEFAULT_ADMIN_DB_CONFIG_PATH);
const adminDbDefaults = readAdminDbDefaults(adminDbConfigPath);
const operationDbConfigPath =
  process.env.IOBEAM_OPERATION_DB_CONFIG?.trim() ||
  firstExistingConfigPath([
    DEPLOYMENT_OPERATION_DB_CONFIG_PATH,
    DEFAULT_OPERATION_DB_CONFIG_PATH,
  ], DEFAULT_OPERATION_DB_CONFIG_PATH);
const operationDbDefaults = readOperationDbDefaults(operationDbConfigPath, adminDbDefaults);

function readAdminDbDefaults(filePath: string): AdminDbDefaults {
  const fallback: AdminDbDefaults = {
    host: process.platform === "win32" ? "localhost" : "/var/run/postgresql",
    port: 5432,
    database: "iobeam_admin",
    user: process.platform === "win32" ? "postgres" : currentLogin(),
    password: null,
    sslMode: null,
    commandTimeoutMs: 30_000,
  };

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const db = readRecord(raw, "Database");
    const source = Object.keys(db).length > 0 ? db : raw;
    const connectionString = stringValue(source.ConnectionString ?? source.connectionString);
    const parsed = connectionString ? parsePostgresConnectionString(connectionString) : {};
    return {
      host: stringValue(source.Host ?? source.host) || parsed.host || fallback.host,
      port: numberValue(source.Port ?? source.port) || parsed.port || fallback.port,
      database:
        stringValue(source.DatabaseName ?? source.databaseName ?? source.Database ?? source.database) ||
        parsed.database ||
        fallback.database,
      user: stringValue(source.User ?? source.user ?? source.Username ?? source.username) || parsed.user || fallback.user,
      password: stringValue(source.Password ?? source.password) || parsed.password || fallback.password,
      sslMode: stringValue(source.SslMode ?? source.sslMode) || parsed.sslMode || fallback.sslMode,
      commandTimeoutMs:
        numberValue(source.CommandTimeoutMs ?? source.commandTimeoutMs) ||
        parsed.commandTimeoutMs ||
        fallback.commandTimeoutMs,
    };
  } catch {
    return fallback;
  }
}

function readOperationDbDefaults(filePath: string, fallbackDefaults: AdminDbDefaults): AdminDbDefaults {
  const fallback: AdminDbDefaults = {
    host: fallbackDefaults.host,
    port: fallbackDefaults.port,
    database: "operation_data",
    user: fallbackDefaults.user,
    password: fallbackDefaults.password,
    sslMode: fallbackDefaults.sslMode,
    commandTimeoutMs: fallbackDefaults.commandTimeoutMs,
  };

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const db = readRecord(raw, "Database");
    const source = Object.keys(db).length > 0 ? db : raw;
    const connectionString = stringValue(source.ConnectionString ?? source.connectionString);
    const parsed = connectionString ? parsePostgresConnectionString(connectionString) : {};
    return {
      host: stringValue(source.Host ?? source.host) || parsed.host || fallback.host,
      port: numberValue(source.Port ?? source.port) || parsed.port || fallback.port,
      database:
        stringValue(source.DatabaseName ?? source.databaseName ?? source.Database ?? source.database) ||
        parsed.database ||
        fallback.database,
      user: stringValue(source.User ?? source.user ?? source.Username ?? source.username) || parsed.user || fallback.user,
      password: stringValue(source.Password ?? source.password) || parsed.password || fallback.password,
      sslMode: stringValue(source.SslMode ?? source.sslMode) || parsed.sslMode || fallback.sslMode,
      commandTimeoutMs:
        numberValue(source.CommandTimeoutMs ?? source.commandTimeoutMs) ||
        parsed.commandTimeoutMs ||
        fallback.commandTimeoutMs,
    };
  } catch {
    return fallback;
  }
}

function readRecord(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePostgresConnectionString(value: string): Partial<AdminDbDefaults> {
  const url = new URL(value);
  if (!["postgres", "postgresql"].includes(url.protocol.replace(":", ""))) {
    return {};
  }
  return {
    host: url.hostname || undefined,
    port: url.port ? Number(url.port) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    sslMode: url.searchParams.get("sslmode") || undefined,
  };
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function numberValue(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeLocalPeerUser(host: string, user: string, password: string | null): string {
  const login = currentLogin();
  if (
    !password &&
    user === "postgres" &&
    login !== "postgres" &&
    (host === "/var/run/postgresql" || host.startsWith("/"))
  ) {
    return login;
  }
  return user;
}

const resolvedAdminDbHost =
  process.env.IOBEAM_ADMIN_DB_HOST?.trim() || adminDbDefaults.host;
const resolvedAdminDbPassword =
  process.env.IOBEAM_ADMIN_DB_PASSWORD?.trim() || adminDbDefaults.password;
const resolvedAdminDbSslMode =
  process.env.IOBEAM_ADMIN_DB_SSLMODE?.trim() || adminDbDefaults.sslMode;
const resolvedAdminDbUser = normalizeLocalPeerUser(
  resolvedAdminDbHost,
  process.env.IOBEAM_ADMIN_DB_USER?.trim() || adminDbDefaults.user,
  resolvedAdminDbPassword,
);
const resolvedOperationDbUser = normalizeLocalPeerUser(
  process.env.IOBEAM_OPERATION_DB_HOST?.trim() || operationDbDefaults.host,
  process.env.IOBEAM_OPERATION_DB_USER?.trim() || operationDbDefaults.user,
  process.env.IOBEAM_OPERATION_DB_PASSWORD?.trim() || operationDbDefaults.password,
);

export const config: Config = {
  port: Number(process.env.PORT ?? 4000),
  proxyTargetHttp: process.env.PROXY_TARGET_HTTP ?? "http://127.0.0.1:8765",
  proxyTargetWs: process.env.PROXY_TARGET_WS ?? "ws://127.0.0.1:8765",
  glasgowToken: process.env.GLASGOW_TOKEN?.trim() || null,
  mock: bool(process.env.MOCK, false),
  mobilityOnly: bool(process.env.IONBEAM_MOBILITY_ONLY, false),
  staticDir: path.resolve(
    __dirname,
    "..",
    process.env.STATIC_DIR ?? "../frontend/dist"
  ),
  configPath: resolveConfigPath(process.env.GLASGOW_CONFIG),
  adminConfigPath: resolveAdminConfigPath(process.env.IOBEAM_ADMIN_CONFIG),
  restartCmd:
    process.env.GLASGOW_RESTART_CMD?.trim() ||
    DEFAULT_RESTART_CMD,
  restartBackendAfterGlasgow: bool(
    process.env.IONBEAM_BACKEND_RESTART_AFTER_GLASGOW,
    DEFAULT_RESTART_BACKEND_AFTER_GLASGOW
  ),
  backendRestartCmd:
    process.env.IONBEAM_BACKEND_RESTART_CMD?.trim() ||
    DEFAULT_BACKEND_RESTART_CMD,
  configStrict: bool(process.env.GLASGOW_CONFIG_STRICT, false),
  adminDbConfigPath,
  adminDbHost: resolvedAdminDbHost,
  adminDbPort: Number(process.env.IOBEAM_ADMIN_DB_PORT ?? adminDbDefaults.port),
  adminDbName: process.env.IOBEAM_ADMIN_DB_NAME?.trim() || adminDbDefaults.database,
  adminDbUser: resolvedAdminDbUser,
  adminDbPassword: resolvedAdminDbPassword,
  adminDbSslMode: resolvedAdminDbSslMode,
  adminDbCommandTimeoutMs: Math.max(
    1_000,
    int(process.env.IOBEAM_ADMIN_DB_COMMAND_TIMEOUT_MS, adminDbDefaults.commandTimeoutMs),
  ),
  operationDbConfigPath,
  operationDbHost: process.env.IOBEAM_OPERATION_DB_HOST?.trim() || operationDbDefaults.host,
  operationDbPort: Number(process.env.IOBEAM_OPERATION_DB_PORT ?? operationDbDefaults.port),
  operationDbName: process.env.IOBEAM_OPERATION_DB_NAME?.trim() || operationDbDefaults.database,
  operationDbUser: resolvedOperationDbUser,
  operationDbPassword:
    process.env.IOBEAM_OPERATION_DB_PASSWORD?.trim() || operationDbDefaults.password,
  operationDbSslMode:
    process.env.IOBEAM_OPERATION_DB_SSLMODE?.trim() || operationDbDefaults.sslMode,
  operationDbCommandTimeoutMs: Math.max(
    1_000,
    int(process.env.IOBEAM_OPERATION_DB_COMMAND_TIMEOUT_MS, operationDbDefaults.commandTimeoutMs),
  ),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || null,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || null,
  smtpHost: process.env.SMTP_HOST?.trim() || null,
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: bool(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER?.trim() || null,
  smtpPassword: process.env.SMTP_PASSWORD?.trim() || null,
  smtpFrom:
    process.env.SMTP_FROM?.trim() ||
    process.env.SMTP_USER?.trim() ||
    null,
};
