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
  staticDir: string;
  configPath: string;
  adminConfigPath: string;
  restartCmd: string;
  restartBackendAfterGlasgow: boolean;
  backendRestartCmd: string | null;
  configStrict: boolean;
  adminDbHost: string;
  adminDbPort: number;
  adminDbName: string;
  adminDbUser: string;
  adminDbPassword: string | null;
  adminDbCommandTimeoutMs: number;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioFromNumber: string | null;
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

export const config: Config = {
  port: Number(process.env.PORT ?? 4000),
  proxyTargetHttp: process.env.PROXY_TARGET_HTTP ?? "http://127.0.0.1:8765",
  proxyTargetWs: process.env.PROXY_TARGET_WS ?? "ws://127.0.0.1:8765",
  glasgowToken: process.env.GLASGOW_TOKEN?.trim() || null,
  mock: bool(process.env.MOCK, false),
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
  adminDbHost:
    process.env.IOBEAM_ADMIN_DB_HOST?.trim() ||
    (process.platform === "win32" ? "localhost" : "/var/run/postgresql"),
  adminDbPort: Number(process.env.IOBEAM_ADMIN_DB_PORT ?? 5432),
  adminDbName: process.env.IOBEAM_ADMIN_DB_NAME?.trim() || "iobeam_admin",
  adminDbUser:
    process.env.IOBEAM_ADMIN_DB_USER?.trim() ||
    (process.platform === "win32" ? "postgres" : currentLogin()),
  adminDbPassword: process.env.IOBEAM_ADMIN_DB_PASSWORD?.trim() || null,
  adminDbCommandTimeoutMs: Math.max(
    1_000,
    int(process.env.IOBEAM_ADMIN_DB_COMMAND_TIMEOUT_MS, 30_000),
  ),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || null,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || null,
};
