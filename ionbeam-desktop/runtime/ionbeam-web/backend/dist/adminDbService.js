"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ADMIN_EXTRA_SCHEMA_FILES = void 0;
exports.pgConnectionFromRuntimeConfig = pgConnectionFromRuntimeConfig;
exports.pgConnectionFromOperationRuntimeConfig = pgConnectionFromOperationRuntimeConfig;
exports.pgConnectionFromAdminConfig = pgConnectionFromAdminConfig;
exports.pgConnectionFromOperationConfig = pgConnectionFromOperationConfig;
exports.applyAdminDatabaseSetup = applyAdminDatabaseSetup;
exports.applyOperationDatabaseSetup = applyOperationDatabaseSetup;
exports.runPsql = runPsql;
exports.resolveSqlFile = resolveSqlFile;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const config_1 = require("./config");
const ADMIN_DB_BACKOFF_MS = 15_000;
const adminDbBackoffByKey = new Map();
function pgConnectionFromRuntimeConfig(source = config_1.config) {
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
function pgConnectionFromOperationRuntimeConfig(source = config_1.config) {
    return {
        host: source.operationDbHost,
        port: source.operationDbPort,
        database: source.operationDbName,
        user: source.operationDbUser,
        password: source.operationDbPassword,
        sslMode: source.operationDbSslMode,
        commandTimeoutMs: source.operationDbCommandTimeoutMs,
    };
}
function pgConnectionFromAdminConfig(data, fallback = pgConnectionFromRuntimeConfig()) {
    const db = readRecord(data, ["Database"]);
    const connectionString = stringValue(db.ConnectionString ?? db.connectionString);
    const parsed = connectionString ? parsePostgresConnectionString(connectionString) : null;
    return {
        host: stringValue(db.Host ?? db.host) || parsed?.host || fallback.host,
        port: numberValue(db.Port ?? db.port) || parsed?.port || fallback.port,
        database: stringValue(db.DatabaseName ?? db.databaseName ?? db.Database ?? db.database) ||
            parsed?.database ||
            fallback.database,
        user: stringValue(db.User ?? db.user ?? db.Username ?? db.username) || parsed?.user || fallback.user,
        password: stringValue(db.Password ?? db.password) ||
            parsed?.password ||
            fallback.password,
        sslMode: stringValue(db.SslMode ?? db.sslMode) || parsed?.sslMode || fallback.sslMode || null,
        commandTimeoutMs: numberValue(db.CommandTimeoutMs ?? db.commandTimeoutMs) ||
            parsed?.commandTimeoutMs ||
            fallback.commandTimeoutMs,
    };
}
function pgConnectionFromOperationConfig(data, fallback = pgConnectionFromOperationRuntimeConfig()) {
    const nested = readRecord(data, ["Database"]);
    const root = data && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
    const db = Object.keys(nested).length > 0 ? nested : root;
    const connectionString = stringValue(db.ConnectionString ?? db.connectionString);
    const parsed = connectionString ? parsePostgresConnectionString(connectionString) : null;
    return {
        host: stringValue(db.Host ?? db.host) || parsed?.host || fallback.host,
        port: numberValue(db.Port ?? db.port) || parsed?.port || fallback.port,
        database: stringValue(db.DatabaseName ?? db.databaseName ?? db.Database ?? db.database) ||
            parsed?.database ||
            "operation_data",
        user: stringValue(db.User ?? db.user ?? db.Username ?? db.username) || parsed?.user || fallback.user,
        password: stringValue(db.Password ?? db.password) ||
            parsed?.password ||
            fallback.password,
        sslMode: stringValue(db.SslMode ?? db.sslMode) || parsed?.sslMode || fallback.sslMode || null,
        commandTimeoutMs: numberValue(db.CommandTimeoutMs ?? db.commandTimeoutMs) ||
            parsed?.commandTimeoutMs ||
            fallback.commandTimeoutMs,
    };
}
/**
 * Idempotent SQL that is loaded after 001_schema.sql (and the optional seed) on every admin database setup.
 * 003 adds the FIB / SEM calibration-parameter tables and stored functions (see calibrationRepository.ts).
 * 005 adds the single-row-per-equipment Dimension Cal setting (see dimensionCalibrationRepository.ts).
 * The 2 MB parameter catalog itself is 004_calibration_seed.sql, loaded by `npm run db:seed:calibration`
 * or automatically the first time the calibration API is used (ensureCalibrationCatalog).
 */
exports.ADMIN_EXTRA_SCHEMA_FILES = ["003_calibration_schema.sql", "005_dimension_calibration_schema.sql"];
async function applyAdminDatabaseSetup(options) {
    return applyDatabaseSetup(options, ["public", "iobeam_admin", "ionbeam_asset"], exports.ADMIN_EXTRA_SCHEMA_FILES);
}
async function applyOperationDatabaseSetup(options) {
    return applyDatabaseSetup(options, ["operation_data"]);
}
async function applyDatabaseSetup(options, grantSchemas, extraSchemaFiles = []) {
    const connection = options.connection;
    const steps = [];
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
    // After the seed on purpose: extra files change search_path, and 002 relies on the one 001 set.
    for (const extra of extraSchemaFiles) {
        sqlFiles.push(readSql(resolveSqlFile(extra)));
    }
    await runPsql(["-v", "ON_ERROR_STOP=1"], connection.database, sqlFiles.join("\n"), connection);
    steps.push({
        name: "load-schema",
        ok: true,
        detail: `loaded ${[node_path_1.default.basename(schemaFile), ...(options.loadSeed === false ? [] : [node_path_1.default.basename(seedFile)]), ...extraSchemaFiles].join(", ")}`,
    });
    if (options.ensureRole !== false) {
        const roleName = (options.roleName || connection.user).trim();
        if (roleName) {
            await runPsql(["-v", "ON_ERROR_STOP=1"], connection.database, roleGrantSql(connection.database, roleName, grantSchemas), connection);
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
function runPsql(args, database = config_1.config.adminDbName, stdin, connection = pgConnectionFromRuntimeConfig()) {
    const target = { ...connection, database };
    const backoffKey = connectionKey(target);
    return new Promise((resolve, reject) => {
        const backoffUntil = adminDbBackoffByKey.get(backoffKey) ?? 0;
        if (Date.now() < backoffUntil) {
            reject(new Error(`psql temporarily unavailable for ${target.host}:${target.port}/${target.database} after a recent connection failure`));
            return;
        }
        let settled = false;
        const child = (0, node_child_process_1.spawn)("psql", [
            "-h",
            target.host,
            "-p",
            String(target.port),
            "-U",
            target.user,
            "-d",
            target.database,
            ...args,
        ], {
            env: {
                ...process.env,
                ...(target.password ? { PGPASSWORD: target.password } : {}),
                ...(target.sslMode ? { PGSSLMODE: target.sslMode } : {}),
                PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(target.commandTimeoutMs / 1000))),
            },
            stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        const timeout = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            adminDbBackoffByKey.set(backoffKey, Date.now() + ADMIN_DB_BACKOFF_MS);
            reject(new Error(`psql timed out after ${target.commandTimeoutMs}ms connecting to ${target.host}:${target.port}/${target.database}`));
        }, target.commandTimeoutMs);
        function finish(fn) {
            if (settled)
                return;
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
async function ensureDatabase(connection, adminDatabase) {
    const existsSql = `SELECT 1 FROM pg_database WHERE datname = ${sqlLiteral(connection.database)}`;
    const out = await runPsql(["-Atqc", existsSql], adminDatabase, undefined, connection);
    if (out.trim() === "1") {
        return { name: "ensure-database", ok: true, detail: `${connection.database} already exists` };
    }
    await runPsql(["-v", "ON_ERROR_STOP=1"], adminDatabase, `CREATE DATABASE ${quoteIdent(connection.database)};`, connection);
    return { name: "ensure-database", ok: true, detail: `created ${connection.database}` };
}
function parsePostgresConnectionString(value) {
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
function resolveSqlFile(configuredPath) {
    if (node_path_1.default.isAbsolute(configuredPath) && node_fs_1.default.existsSync(configuredPath))
        return configuredPath;
    const developmentRoot = node_path_1.default.resolve(__dirname, "..", "..", "..");
    const candidates = [
        configuredPath,
        node_path_1.default.join(developmentRoot, "IobeamAdmin", "Sql", configuredPath),
        node_path_1.default.join(developmentRoot, configuredPath),
    ];
    const found = candidates.find((candidate) => node_fs_1.default.existsSync(candidate));
    if (!found) {
        throw new Error(`SQL file not found: ${configuredPath}`);
    }
    return found;
}
function readSql(filePath) {
    return node_fs_1.default.readFileSync(filePath, "utf8");
}
function roleGrantSql(dbName, roleName, schemas) {
    const dbIdent = quoteIdent(dbName);
    const roleIdent = quoteIdent(roleName);
    const roleLiteral = sqlLiteral(roleName);
    const schemaList = schemas.length > 0 ? schemas : ["public"];
    const schemaGrantLines = schemaList.flatMap((schemaName) => {
        const schemaIdent = quoteIdent(schemaName);
        return [
            `GRANT USAGE, CREATE ON SCHEMA ${schemaIdent} TO ${roleIdent};`,
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaIdent} TO ${roleIdent};`,
            `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemaIdent} TO ${roleIdent};`,
            `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemaIdent} TO ${roleIdent};`,
            `GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA ${schemaIdent} TO ${roleIdent};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleIdent};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT EXECUTE ON FUNCTIONS TO ${roleIdent};`,
        ];
    });
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
        ...schemaGrantLines,
    ].join("\n");
}
function readRecord(data, pathParts) {
    let current = data;
    for (const part of pathParts) {
        if (!current || typeof current !== "object")
            return {};
        current = current[part];
    }
    return current && typeof current === "object" && !Array.isArray(current)
        ? current
        : {};
}
function stringValue(value) {
    return String(value ?? "").trim();
}
function numberValue(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}
function quoteIdent(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}
function sqlLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
function connectionKey(connection) {
    return `${connection.host}:${connection.port}:${connection.database}:${connection.user}`;
}
function isDbConnectivityError(message) {
    return /timed out after|could not connect to server|connection refused|timeout/i.test(message);
}
//# sourceMappingURL=adminDbService.js.map