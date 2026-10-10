"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
/**
 * Environment loader. Centralised so the rest of the backend can read a
 * single typed object instead of poking process.env directly.
 */
const dotenv_1 = __importDefault(require("dotenv"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
dotenv_1.default.config({ path: node_path_1.default.resolve(__dirname, "..", ".env") });
function bool(v, fallback) {
    if (v === undefined)
        return fallback;
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function int(v, fallback) {
    const n = Number(v ?? fallback);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function currentLogin() {
    try {
        const username = node_os_1.default.userInfo().username.trim();
        if (username)
            return username;
    }
    catch {
        // Fall through to environment-based fallbacks below.
    }
    return process.env.USER?.trim() || process.env.LOGNAME?.trim() || "postgres";
}
const BACKEND_ROOT = node_path_1.default.resolve(__dirname, "..");
const DEPLOY_DEVELOPMENT_ROOT = node_path_1.default.resolve(BACKEND_ROOT, "..", "..");
const DEFAULT_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "GlasgowDataIO", "Json", "streamData.json");
const DEFAULT_VACUUM_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "GlasgowDataIO", "Json", "vacuumSystem.json");
const DEFAULT_SAMPLE_STAGE_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "GlasgowDataIO", "Json", "sampleStageSystem.json");
const DEFAULT_ADMIN_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "IobeamAdmin", "Json", "IobeamAdmin.json");
const DEFAULT_ADMIN_DB_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "IobeamAdmin", "Json", "IobeamAdminDb.json");
const DEFAULT_OPERATION_DB_CONFIG_PATH = node_path_1.default.join(DEPLOY_DEVELOPMENT_ROOT, "OperationData", "Json", "OperationDataDb.json");
const DEFAULT_RESTART_CMD = node_path_1.default.join(BACKEND_ROOT, "scripts", "restart-glasgow-service.sh");
const DEFAULT_BACKEND_RESTART_CMD = node_path_1.default.join(BACKEND_ROOT, "scripts", "restart-ionbeam-backend.sh");
const adminDbConfigPath = process.env.IOBEAM_ADMIN_DB_CONFIG?.trim() || DEFAULT_ADMIN_DB_CONFIG_PATH;
const adminDbDefaults = readAdminDbDefaults(adminDbConfigPath);
const operationDbConfigPath = process.env.IOBEAM_OPERATION_DB_CONFIG?.trim() || DEFAULT_OPERATION_DB_CONFIG_PATH;
const operationDbDefaults = readOperationDbDefaults(operationDbConfigPath, adminDbDefaults);
function readAdminDbDefaults(filePath) {
    const fallback = {
        host: "/var/run/postgresql",
        port: 5432,
        database: "iobeam_admin",
        user: currentLogin(),
        password: null,
        sslMode: null,
        commandTimeoutMs: 30_000,
    };
    try {
        const raw = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        const db = readRecord(raw, "Database");
        const source = Object.keys(db).length > 0 ? db : raw;
        const connectionString = stringValue(source.ConnectionString ?? source.connectionString);
        const parsed = connectionString ? parsePostgresConnectionString(connectionString) : {};
        return {
            host: stringValue(source.Host ?? source.host) || parsed.host || fallback.host,
            port: numberValue(source.Port ?? source.port) || parsed.port || fallback.port,
            database: stringValue(source.DatabaseName ?? source.databaseName ?? source.Database ?? source.database) ||
                parsed.database ||
                fallback.database,
            user: stringValue(source.User ?? source.user ?? source.Username ?? source.username) || parsed.user || fallback.user,
            password: stringValue(source.Password ?? source.password) || parsed.password || fallback.password,
            sslMode: stringValue(source.SslMode ?? source.sslMode) || parsed.sslMode || fallback.sslMode,
            commandTimeoutMs: numberValue(source.CommandTimeoutMs ?? source.commandTimeoutMs) ||
                parsed.commandTimeoutMs ||
                fallback.commandTimeoutMs,
        };
    }
    catch {
        return fallback;
    }
}
function readOperationDbDefaults(filePath, fallbackDefaults) {
    const fallback = {
        host: fallbackDefaults.host,
        port: fallbackDefaults.port,
        database: "operation_data",
        user: fallbackDefaults.user,
        password: fallbackDefaults.password,
        sslMode: fallbackDefaults.sslMode,
        commandTimeoutMs: fallbackDefaults.commandTimeoutMs,
    };
    try {
        const raw = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        const db = readRecord(raw, "Database");
        const source = Object.keys(db).length > 0 ? db : raw;
        const connectionString = stringValue(source.ConnectionString ?? source.connectionString);
        const parsed = connectionString ? parsePostgresConnectionString(connectionString) : {};
        return {
            host: stringValue(source.Host ?? source.host) || parsed.host || fallback.host,
            port: numberValue(source.Port ?? source.port) || parsed.port || fallback.port,
            database: stringValue(source.DatabaseName ?? source.databaseName ?? source.Database ?? source.database) ||
                parsed.database ||
                fallback.database,
            user: stringValue(source.User ?? source.user ?? source.Username ?? source.username) || parsed.user || fallback.user,
            password: stringValue(source.Password ?? source.password) || parsed.password || fallback.password,
            sslMode: stringValue(source.SslMode ?? source.sslMode) || parsed.sslMode || fallback.sslMode,
            commandTimeoutMs: numberValue(source.CommandTimeoutMs ?? source.commandTimeoutMs) ||
                parsed.commandTimeoutMs ||
                fallback.commandTimeoutMs,
        };
    }
    catch {
        return fallback;
    }
}
function readRecord(data, key) {
    const value = data[key];
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function parsePostgresConnectionString(value) {
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
function stringValue(value) {
    return String(value ?? "").trim();
}
function numberValue(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}
function normalizeLocalPeerUser(host, user, password) {
    const login = currentLogin();
    if (!password &&
        user === "postgres" &&
        login !== "postgres" &&
        (host === "/var/run/postgresql" || host.startsWith("/"))) {
        return login;
    }
    return user;
}
const resolvedAdminDbHost = process.env.IOBEAM_ADMIN_DB_HOST?.trim() || adminDbDefaults.host;
const resolvedAdminDbPassword = process.env.IOBEAM_ADMIN_DB_PASSWORD?.trim() || adminDbDefaults.password;
const resolvedAdminDbSslMode = process.env.IOBEAM_ADMIN_DB_SSLMODE?.trim() || adminDbDefaults.sslMode;
const resolvedAdminDbUser = normalizeLocalPeerUser(resolvedAdminDbHost, process.env.IOBEAM_ADMIN_DB_USER?.trim() || adminDbDefaults.user, resolvedAdminDbPassword);
const resolvedOperationDbUser = normalizeLocalPeerUser(process.env.IOBEAM_OPERATION_DB_HOST?.trim() || operationDbDefaults.host, process.env.IOBEAM_OPERATION_DB_USER?.trim() || operationDbDefaults.user, process.env.IOBEAM_OPERATION_DB_PASSWORD?.trim() || operationDbDefaults.password);
exports.config = {
    port: Number(process.env.PORT ?? 4000),
    proxyTargetHttp: process.env.PROXY_TARGET_HTTP ?? "http://127.0.0.1:8765",
    vacuumControllerUrl: process.env.VACUUM_CONTROLLER_URL ?? "http://127.0.0.1:8780",
    sampleStageControllerUrl: process.env.SAMPLE_STAGE_CONTROLLER_URL ?? "http://127.0.0.1:8790",
    proxyTargetWs: process.env.PROXY_TARGET_WS ?? "ws://127.0.0.1:8765",
    glasgowToken: process.env.GLASGOW_TOKEN?.trim() || null,
    mock: bool(process.env.MOCK, false),
    mobilityOnly: bool(process.env.IONBEAM_MOBILITY_ONLY, false),
    staticDir: node_path_1.default.resolve(__dirname, "..", process.env.STATIC_DIR ?? "../frontend/dist"),
    configPath: process.env.GLASGOW_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
    vacuumConfigPath: process.env.SBC_VACUUM_CONFIG?.trim() || DEFAULT_VACUUM_CONFIG_PATH,
    sampleStageConfigPath: process.env.SAMPLE_STAGE_CONFIG?.trim() || DEFAULT_SAMPLE_STAGE_CONFIG_PATH,
    adminConfigPath: process.env.IOBEAM_ADMIN_CONFIG?.trim() || DEFAULT_ADMIN_CONFIG_PATH,
    restartCmd: process.env.GLASGOW_RESTART_CMD?.trim() ||
        DEFAULT_RESTART_CMD,
    restartBackendAfterGlasgow: bool(process.env.IONBEAM_BACKEND_RESTART_AFTER_GLASGOW, true),
    backendRestartCmd: process.env.IONBEAM_BACKEND_RESTART_CMD?.trim() ||
        DEFAULT_BACKEND_RESTART_CMD,
    configStrict: bool(process.env.GLASGOW_CONFIG_STRICT, false),
    adminDbConfigPath,
    adminDbHost: resolvedAdminDbHost,
    adminDbPort: Number(process.env.IOBEAM_ADMIN_DB_PORT ?? adminDbDefaults.port),
    adminDbName: process.env.IOBEAM_ADMIN_DB_NAME?.trim() || adminDbDefaults.database,
    adminDbUser: resolvedAdminDbUser,
    adminDbPassword: resolvedAdminDbPassword,
    adminDbSslMode: resolvedAdminDbSslMode,
    adminDbCommandTimeoutMs: Math.max(1_000, int(process.env.IOBEAM_ADMIN_DB_COMMAND_TIMEOUT_MS, adminDbDefaults.commandTimeoutMs)),
    operationDbConfigPath,
    operationDbHost: process.env.IOBEAM_OPERATION_DB_HOST?.trim() || operationDbDefaults.host,
    operationDbPort: Number(process.env.IOBEAM_OPERATION_DB_PORT ?? operationDbDefaults.port),
    operationDbName: process.env.IOBEAM_OPERATION_DB_NAME?.trim() || operationDbDefaults.database,
    operationDbUser: resolvedOperationDbUser,
    operationDbPassword: process.env.IOBEAM_OPERATION_DB_PASSWORD?.trim() || operationDbDefaults.password,
    operationDbSslMode: process.env.IOBEAM_OPERATION_DB_SSLMODE?.trim() || operationDbDefaults.sslMode,
    operationDbCommandTimeoutMs: Math.max(1_000, int(process.env.IOBEAM_OPERATION_DB_COMMAND_TIMEOUT_MS, operationDbDefaults.commandTimeoutMs)),
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || null,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || null,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || null,
    smtpHost: process.env.SMTP_HOST?.trim() || null,
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpSecure: bool(process.env.SMTP_SECURE, false),
    smtpUser: process.env.SMTP_USER?.trim() || null,
    smtpPassword: process.env.SMTP_PASSWORD?.trim() || null,
    smtpFrom: process.env.SMTP_FROM?.trim() ||
        process.env.SMTP_USER?.trim() ||
        null,
};
//# sourceMappingURL=config.js.map