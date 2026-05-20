/**
 * Environment loader. Centralised so the rest of the backend can read a
 * single typed object instead of poking process.env directly.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export interface Config {
  port: number;
  proxyTargetHttp: string;
  proxyTargetWs: string;
  glasgowToken: string | null;
  mock: boolean;
  staticDir: string;
  configPath: string;
  restartCmd: string;
  configStrict: boolean;
}

const BACKEND_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..", "..");
const DEFAULT_CONFIG_PATH = path.join(
  REPO_ROOT,
  "GlasgowDataIO",
  "Json",
  "streamData.json"
);
const RESTART_SCRIPT = process.platform === "win32"
  ? path.join(BACKEND_ROOT, "scripts", "restart-glasgow-service.ps1")
  : path.join(BACKEND_ROOT, "scripts", "restart-glasgow-service.sh");
const DEFAULT_RESTART_CMD = process.platform === "win32"
  ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${RESTART_SCRIPT}"`
  : RESTART_SCRIPT;

function hasStreamDataTail(p: string): boolean {
  const parts = path.normalize(p).split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-3).map((part) => part.toLowerCase());
  return tail.join("/") === "glasgowdataio/json/streamdata.json";
}

function resolveConfigPath(raw: string | undefined): string {
  const candidate = raw?.trim();
  if (!candidate) return DEFAULT_CONFIG_PATH;
  if (fs.existsSync(candidate)) return path.resolve(candidate);
  if (hasStreamDataTail(candidate) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return DEFAULT_CONFIG_PATH;
  }
  return candidate;
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
  restartCmd:
    process.env.GLASGOW_RESTART_CMD?.trim() ||
    DEFAULT_RESTART_CMD,
  configStrict: bool(process.env.GLASGOW_CONFIG_STRICT, false),
};
