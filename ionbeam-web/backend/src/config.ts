/**
 * Environment loader. Centralised so the rest of the backend can read a
 * single typed object instead of poking process.env directly.
 */
import dotenv from "dotenv";
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
};
