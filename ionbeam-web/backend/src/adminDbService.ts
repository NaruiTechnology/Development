import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { config, type Config } from "./config";

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
  sslMode?: string | null;
  commandTimeoutMs: number;
}

export interface AdminDatabaseSetupOptions {
  connection: PgConnection;
  adminDatabase?: string;
  schemaFile?: string;
  seedFile?: string;
  loadSeed?: boolean;
  ensureDatabase?: boolean;
  ensureRole?: boolean;
  roleName?: string;
}

export interface AdminDatabaseSetupResult {
  ok: true;
  connection: Omit<PgConnection, "password"> & { password: boolean };
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}

const ADMIN_DB_BACKOFF_MS = 15_000;
const adminDbBackoffByKey = new Map<string, number>();

export function pgConnectionFromRuntimeConfig(source: Config = config): PgConnection {
  return {
    host: source.adminDbHost,
    port: source.adminDbPort,
    database: source.adminDbName,
    user: source.adminDbUser,
    password: source.adminDbPassword,
    sslMode: source.adminDbSslMode,
    commandTimeoutMs: source.adminDbCommandTimeoutMs,
  };
}

export function pgConnectionFromAdminConfig(data: unknown, fallback: PgConnection = pgConnectionFromRuntimeConfig()): PgConnection {
  const db = readRecord(data, ["Database"]);
  const connectionString = stringValue(db.ConnectionString ?? db.connectionString);
  const parsed = connectionString ? parsePostgresConnectionString(connectionString) : null;
  return {
    host: stringValue(db.Host ?? db.host) || parsed?.host || fallback.host,
    port: numberValue(db.Port ?? db.port) || parsed?.port || fallback.port,
    database:
      stringValue(db.DatabaseName ?? db.databaseName ?? db.Database ?? db.database) ||
      parsed?.database ||
      fallback.database,
    user: stringValue(db.User ?? db.user ?? db.Username ?? db.username) || parsed?.user || fallback.user,
    password:
      stringValue(db.Password ?? db.password) ||
      parsed?.password ||
      fallback.password,
    sslMode: stringValue(db.SslMode ?? db.sslMode) || parsed?.sslMode || fallback.sslMode || null,
    commandTimeoutMs:
      numberValue(db.CommandTimeoutMs ?? db.commandTimeoutMs) ||
      parsed?.commandTimeoutMs ||
      fallback.commandTimeoutMs,
  };
}

export async function applyAdminDatabaseSetup(options: AdminDatabaseSetupOptions): Promise<AdminDatabaseSetupResult> {
  const connection = options.connection;
  const steps: AdminDatabaseSetupResult["steps"] = [];
  const adminDatabase = options.adminDatabase || "postgres";
  const schemaFile = resolveSqlFile(options.schemaFile || "001_schema.sql");
  const seedFile = resolveSqlFile(options.seedFile || "002_seed_root_user.sql");

  if (options.ensureDatabase !== false) {
    const created = await ensureDatabase(connection, adminDatabase);
    steps.push(created);
  }

  const sqlFiles = [readSql(schemaFile)];
  if (options.loadSeed !== false) {
    sqlFiles.push(readSql(seedFile));
  }
  await runPsql(["-v", "ON_ERROR_STOP=1"], connection.database, sqlFiles.join("\n"), connection);
  steps.push({
    name: "load-schema",
    ok: true,
    detail: `loaded ${path.basename(schemaFile)}${options.loadSeed === false ? "" : ` and ${path.basename(seedFile)}`}`,
  });

  if (options.ensureRole !== false) {
    const roleName = (options.roleName || connection.user).trim();
    if (roleName) {
      await runPsql(["-v", "ON_ERROR_STOP=1"], connection.database, roleGrantSql(connection.database, roleName), connection);
      steps.push({ name: "ensure-role", ok: true, detail: `ensured role and grants for ${roleName}` });
    }
  }

  return {
    ok: true,
    connection: {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: Boolean(connection.password),
      sslMode: connection.sslMode,
      commandTimeoutMs: connection.commandTimeoutMs,
    },
    steps,
  };
}

export function runPsql(
  args: string[],
  database = config.adminDbName,
  stdin?: string,
  connection: PgConnection = pgConnectionFromRuntimeConfig(),
): Promise<string> {
  const target = { ...connection, database };
  const backoffKey = connectionKey(target);
  return new Promise((resolve, reject) => {
    const backoffUntil = adminDbBackoffByKey.get(backoffKey) ?? 0;
    if (Date.now() < backoffUntil) {
      reject(
        new Error(
          `psql temporarily unavailable for ${target.host}:${target.port}/${target.database} after a recent connection failure`,
        ),
      );
      return;
    }

    let settled = false;
    const child = spawn(
      "psql",
      [
        "-h",
        target.host,
        "-p",
        String(target.port),
        "-U",
        target.user,
        "-d",
        target.database,
        ...args,
      ],
      {
        env: {
          ...process.env,
          ...(target.password ? { PGPASSWORD: target.password } : {}),
          ...(target.sslMode ? { PGSSLMODE: target.sslMode } : {}),
          PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(target.commandTimeoutMs / 1000))),
        },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      adminDbBackoffByKey.set(backoffKey, Date.now() + ADMIN_DB_BACKOFF_MS);
      reject(
        new Error(
          `psql timed out after ${target.commandTimeoutMs}ms connecting to ${target.host}:${target.port}/${target.database}`,
        ),
      );
    }, target.commandTimeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    if (stdin !== undefined) {
      child.stdin?.setDefaultEncoding("utf8");
      child.stdin?.end(stdin);
    }
    child.on("error", (err) => {
      finish(() => {
        if (isDbConnectivityError(err.message)) {
          adminDbBackoffByKey.set(backoffKey, Date.now() + ADMIN_DB_BACKOFF_MS);
        }
        reject(err);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          adminDbBackoffByKey.set(backoffKey, 0);
          resolve(stdout);
          return;
        }
        const message = stderr.trim() || `psql exited with code ${code}`;
        if (isDbConnectivityError(message)) {
          adminDbBackoffByKey.set(backoffKey, Date.now() + ADMIN_DB_BACKOFF_MS);
        }
        reject(new Error(message));
      });
    });
  });
}

async function ensureDatabase(connection: PgConnection, adminDatabase: string): Promise<{ name: string; ok: boolean; detail: string }> {
  const existsSql = `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(connection.database)}`;
  const out = await runPsql(["-Atqc", existsSql], adminDatabase, undefined, connection);
  if (out.trim() === "1") {
    return { name: "ensure-database", ok: true, detail: `${connection.database} already exists` };
  }

  await runPsql(["-v", "ON_ERROR_STOP=1"], adminDatabase, `CREATE DATABASE ${quoteIdent(connection.database)};`, connection);
  return { name: "ensure-database", ok: true, detail: `created ${connection.database}` };
}

function parsePostgresConnectionString(value: string): Partial<PgConnection> {
  const url = new URL(value);
  if (!["postgres", "postgresql"].includes(url.protocol.replace(":", ""))) {
    throw new Error("connection string must use postgres:// or postgresql://");
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

function resolveSqlFile(configuredPath: string): string {
  if (path.isAbsolute(configuredPath) && fs.existsSync(configuredPath)) return configuredPath;
  const developmentRoot = path.resolve(__dirname, "..", "..", "..");
  const candidates = [
    configuredPath,
    path.join(developmentRoot, "IobeamAdmin", "Sql", configuredPath),
    path.join(developmentRoot, configuredPath),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`SQL file not found: ${configuredPath}`);
  }
  return found;
}

function readSql(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function roleGrantSql(dbName: string, roleName: string): string {
  const dbIdent = quoteIdent(dbName);
  const roleIdent = quoteIdent(roleName);
  const roleLiteral = sqlLiteral(roleName);
  return [
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLiteral}) THEN`,
    `    EXECUTE 'CREATE ROLE ' || quote_ident(${roleLiteral}) || ' LOGIN';`,
    "  ELSE",
    `    EXECUTE 'ALTER ROLE ' || quote_ident(${roleLiteral}) || ' LOGIN';`,
    "  END IF;",
    "END",
    "$$;",
    `GRANT CONNECT ON DATABASE ${dbIdent} TO ${roleIdent};`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${roleIdent};`,
    `GRANT USAGE, CREATE ON SCHEMA iobeam_admin TO ${roleIdent};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iobeam_admin TO ${roleIdent};`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA iobeam_admin TO ${roleIdent};`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA iobeam_admin TO ${roleIdent};`,
    `GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA iobeam_admin TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT EXECUTE ON FUNCTIONS TO ${roleIdent};`,
    `GRANT USAGE, CREATE ON SCHEMA ionbeam_asset TO ${roleIdent};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ionbeam_asset TO ${roleIdent};`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ionbeam_asset TO ${roleIdent};`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ionbeam_asset TO ${roleIdent};`,
    `GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA ionbeam_asset TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleIdent};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ionbeam_asset GRANT EXECUTE ON FUNCTIONS TO ${roleIdent};`,
  ].join("\n");
}

function readRecord(data: unknown, pathParts: ReadonlyArray<string>): Record<string, unknown> {
  let current = data;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return {};
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function numberValue(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function quoteIdent(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function connectionKey(connection: PgConnection): string {
  return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}

function isDbConnectivityError(message: string): boolean {
  return /timed out after|could not connect to server|connection refused|timeout/i.test(message);
}
