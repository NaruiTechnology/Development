/**
 * Environment loader. Centralised so the rest of the backend can read a
 * single typed object instead of poking process.env directly.
 */
import dotenv from "dotenv";
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
  return process.env.USER?.trim() || process.env.LOGNAME?.trim() || "postgres";
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
const DEPLOY_DEVELOPMENT_ROOT = path.resolve(BACKEND_ROOT, "..", "..");
const DEFAULT_CONFIG_PATH = path.join(
  DEPLOY_DEVELOPMENT_ROOT,
  "GlasgowDataIO",
  "Json",
  "streamData.json"
);
const DEFAULT_ADMIN_CONFIG_PATH = path.join(
  DEPLOY_DEVELOPMENT_ROOT,
  "IobeamAdmin",
  "Json",
  "IobeamAdmin.json"
);
const DEFAULT_RESTART_CMD = path.join(
  BACKEND_ROOT,
  "scripts",
  "restart-glasgow-service.sh"
);
const DEFAULT_BACKEND_RESTART_CMD = path.join(
  BACKEND_ROOT,
  "scripts",
  "restart-ionbeam-backend.sh"
);

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
  configPath: process.env.GLASGOW_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
  adminConfigPath:
    process.env.IOBEAM_ADMIN_CONFIG?.trim() || DEFAULT_ADMIN_CONFIG_PATH,
  restartCmd:
    process.env.GLASGOW_RESTART_CMD?.trim() ||
    DEFAULT_RESTART_CMD,
  restartBackendAfterGlasgow: bool(
    process.env.IONBEAM_BACKEND_RESTART_AFTER_GLASGOW,
    true
  ),
  backendRestartCmd:
    process.env.IONBEAM_BACKEND_RESTART_CMD?.trim() ||
    DEFAULT_BACKEND_RESTART_CMD,
  configStrict: bool(process.env.GLASGOW_CONFIG_STRICT, false),
  adminDbHost: process.env.IOBEAM_ADMIN_DB_HOST?.trim() || "/var/run/postgresql",
  adminDbPort: Number(process.env.IOBEAM_ADMIN_DB_PORT ?? 5432),
  adminDbName: process.env.IOBEAM_ADMIN_DB_NAME?.trim() || "iobeam_admin",
  adminDbUser: process.env.IOBEAM_ADMIN_DB_USER?.trim() || currentLogin(),
  adminDbPassword: process.env.IOBEAM_ADMIN_DB_PASSWORD?.trim() || null,
  adminDbCommandTimeoutMs: Math.max(
    1_000,
    int(process.env.IOBEAM_ADMIN_DB_COMMAND_TIMEOUT_MS, 30_000),
  ),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || null,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || null,
};
