"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = void 0;
exports.backupPathFor = backupPathFor;
exports.readWithBackup = readWithBackup;
exports.readAdminWithBackup = readAdminWithBackup;
exports.writeConfig = writeConfig;
exports.writeAdminConfig = writeAdminConfig;
exports.restoreFromBackup = restoreFromBackup;
exports.restoreAdminFromBackup = restoreAdminFromBackup;
exports.restartService = restartService;
/**
 * configManager — owns the streamData.json file plus its backup sibling,
 * and the post-write service restart.
 *
 * Responsibilities
 * ----------------
 *  - Read the active config and parse it to a structured JSON value.
 *  - Lazily create a one-time `streamData_default.json` snapshot of the
 *    original file on the first read. Once created, the backup is
 *    treated as a frozen "factory defaults" copy — write paths NEVER
 *    overwrite it. The only way to refresh it is to delete it from
 *    disk and call readWithBackup() again.
 *  - Write a (potentially edited) config back to the same path,
 *    atomically (write-to-tmp then rename) so a partial write can't
 *    leave the service with a corrupt JSON.
 *  - Restore from the backup (file copy, same atomic pattern).
 *  - Run the configured restart command after each write so the
 *    FastAPI service re-reads the file. The command and its working
 *    directory are configurable; output is captured and surfaced to
 *    the caller so dialog failures are debuggable.
 *
 * What this module does NOT do
 * ----------------------------
 *  - It does not validate the shape of the JSON beyond "is it valid
 *    JSON?". The schema is owned by the python service (Pydantic
 *    models in glasgow_service.models), and re-implementing it on the
 *    Node side would put us in version-skew territory the first time
 *    the python schema changes. The dialog on the frontend constrains
 *    edits to known fields; arbitrary structural damage is the user's
 *    problem (and they can always hit the Default button).
 */
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const config_1 = require("./config");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
/** Suffix appended to derive the backup filename next to the live config. */
const BACKUP_SUFFIX = "_default.json";
/** Max bytes accepted on a config write. Generous — the real file is ~6 KB. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
/** How long to wait for the restart command before giving up. */
const RESTART_TIMEOUT_MS = 30_000;
class ConfigError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.name = "ConfigError";
    }
}
exports.ConfigError = ConfigError;
/**
 * Derive the backup path from the live path. Always lives next to the
 * source so a single directory move keeps both files together.
 *
 *   /a/b/streamData.json  ->  /a/b/streamData_default.json
 *   /a/b/foo.json         ->  /a/b/foo_default.json
 *   /a/b/foo              ->  /a/b/foo_default.json
 */
function backupPathFor(configPath) {
    const dir = node_path_1.default.dirname(configPath);
    const base = node_path_1.default.basename(configPath);
    const ext = node_path_1.default.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    return node_path_1.default.join(dir, `${stem}${BACKUP_SUFFIX}`);
}
/**
 * Read the live config, parse it, and ensure the backup exists. The
 * first time we touch a fresh install this also creates the backup as
 * a verbatim copy of the live file, which is the documented invariant
 * the "Default" button relies on.
 */
async function readWithBackup() {
    return readConfigFileWithBackup(config_1.config.configPath);
}
async function readAdminWithBackup() {
    return readConfigFileWithBackup(config_1.config.adminConfigPath);
}
async function readConfigFileWithBackup(configPath) {
    const backupPath = backupPathFor(configPath);
    let raw;
    try {
        raw = await promises_1.default.readFile(configPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new ConfigError(`config file not found: ${configPath}`, 404);
        }
        throw new ConfigError(`failed to read config file ${configPath}: ${err.message}`, 500);
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch (err) {
        throw new ConfigError(`config file is not valid JSON: ${err.message}`, 500);
    }
    // Lazy backup creation. Only on first read of a config that has no
    // sibling backup yet — never overwrite an existing backup, even if
    // the live file has since diverged.
    let backupCreated = false;
    let hasBackup = await fileExists(backupPath);
    if (!hasBackup) {
        try {
            await atomicWrite(backupPath, raw);
            backupCreated = true;
            hasBackup = true;
        }
        catch (err) {
            // Don't fail the whole read just because we couldn't create the
            // backup (most likely a permission issue). Surface has_backup=false
            // and let the UI disable the Default button.
            console.warn(`[configManager] failed to create backup at ${backupPath}: ${err.message}`);
        }
    }
    return {
        path: configPath,
        backup_path: backupPath,
        data,
        has_backup: hasBackup,
        backup_created: backupCreated,
    };
}
/**
 * Write `data` to the live config path atomically. Does NOT modify the
 * backup. Caller should invoke restartService() afterwards if the change
 * needs to take effect in the FastAPI process.
 */
async function writeConfig(data) {
    await writeJsonConfig(config_1.config.configPath, data, true);
}
async function writeAdminConfig(data) {
    await writeJsonConfig(config_1.config.adminConfigPath, data, false);
}
async function writeJsonConfig(configPath, data, useStrictMode) {
    if (useStrictMode) {
        validateAdcTiming(data);
    }
    // Reject silly-large payloads up front. The Express body parser is
    // already capped at 16 MB; this is a tighter check on what we'll
    // actually accept for a config write specifically.
    const serialized = JSON.stringify(data, null, 4) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
        throw new ConfigError(`config payload too large (>${MAX_CONFIG_BYTES} bytes)`, 413);
    }
    if (useStrictMode && config_1.config.configStrict) {
        if (!(await fileExists(configPath))) {
            throw new ConfigError(`strict mode: config file does not exist: ${configPath}`, 404);
        }
    }
    else {
        // Make sure the directory exists. The python side won't have done
        // this for us if the dialog is being used on a bare install.
        await promises_1.default.mkdir(node_path_1.default.dirname(configPath), { recursive: true });
    }
    await atomicWrite(configPath, serialized);
}
function validateAdcTiming(data) {
    const root = asRecord(data);
    const actions = root && Array.isArray(root.Actions) ? root.Actions : null;
    const firstAction = actions && actions.length > 0 ? asRecord(actions[0]) : null;
    const streamData = firstAction ? asRecord(firstAction.streamData) : null;
    const actionData = streamData ? asRecord(streamData.actionData) : null;
    if (!actionData)
        return;
    const halfPeriod = actionData.adcHalfPeriod ?? 3;
    const settleCycles = actionData.adcSettleCycles ?? 1;
    const latchCycles = actionData.adcLatchCycles ?? 1;
    const turnaroundCycles = actionData.busTurnaroundCycles ?? 0;
    const dacSetupCycles = actionData.dacDataSetupCycles ?? 1;
    const dacLatchCycles = actionData.dacLatchCycles ?? 1;
    if (!Number.isInteger(halfPeriod) || !Number.isInteger(settleCycles)
        || !Number.isInteger(latchCycles) || !Number.isInteger(turnaroundCycles)
        || !Number.isInteger(dacSetupCycles) || !Number.isInteger(dacLatchCycles)
        || halfPeriod < 2 || halfPeriod > 255
        || settleCycles < 1 || settleCycles > 255
        || latchCycles < 1 || latchCycles > 255
        || turnaroundCycles < 0 || turnaroundCycles > 255
        || dacSetupCycles < 1 || dacSetupCycles > 255
        || dacLatchCycles < 1 || dacLatchCycles > 255
        || latchCycles + settleCycles > halfPeriod
        || halfPeriod * 2
            < settleCycles + latchCycles
                + turnaroundCycles
                + 2 * (dacSetupCycles + dacLatchCycles)) {
        throw new ConfigError("invalid ADC timing: adcHalfPeriod must be 2..255; adcSettleCycles, " +
            "adcLatchCycles, dacDataSetupCycles, and dacLatchCycles must be 1..255; " +
            "busTurnaroundCycles must be 0..255; and the complete transaction must " +
            "fit within 2 * adcHalfPeriod, with ADC latch + settle fitting in one half-period", 400);
    }
}
function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
/**
 * Replace the live config with a verbatim copy of the backup. Throws
 * if the backup is missing (the UI should keep the button disabled in
 * that case, but the check is defensive against a stale page state).
 */
async function restoreFromBackup() {
    await restoreConfigFileFromBackup(config_1.config.configPath);
}
async function restoreAdminFromBackup() {
    await restoreConfigFileFromBackup(config_1.config.adminConfigPath);
}
async function restoreConfigFileFromBackup(configPath) {
    const backupPath = backupPathFor(configPath);
    let raw;
    try {
        raw = await promises_1.default.readFile(backupPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            throw new ConfigError(`no backup to restore from: ${backupPath}`, 404);
        }
        throw new ConfigError(`failed to read backup file ${backupPath}: ${err.message}`, 500);
    }
    // Validate the backup is still parseable. If somebody hand-edited the
    // _default.json into something invalid, restoring it would just break
    // the service — better to bail with a clear error.
    try {
        JSON.parse(raw);
    }
    catch (err) {
        throw new ConfigError(`backup file is not valid JSON: ${err.message}`, 500);
    }
    await atomicWrite(configPath, raw);
}
/**
 * Execute the configured restart command. We don't throw on a non-zero
 * exit — the file write already succeeded and we want the caller to
 * be able to surface the restart failure to the operator (who may need
 * to restart the service manually).
 */
async function restartService() {
    const command = config_1.config.restartCmd;
    try {
        const { stdout, stderr } = await execAsync(command, {
            timeout: RESTART_TIMEOUT_MS,
            maxBuffer: 256 * 1024,
        });
        return {
            ok: true,
            command,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
        };
    }
    catch (err) {
        return {
            ok: false,
            command,
            stdout: truncate(err.stdout ?? ""),
            stderr: truncate(err.stderr ?? ""),
            error: err.message ?? String(err),
        };
    }
}
/* -------- helpers ------------------------------------------------------ */
async function fileExists(p) {
    try {
        await promises_1.default.access(p, node_fs_1.default.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Write to a tmpfile in the same directory then rename. fs.rename is
 * atomic within a filesystem, so a power-loss / crash during the write
 * can't leave a half-written config behind.
 */
async function atomicWrite(targetPath, contents) {
    const dir = node_path_1.default.dirname(targetPath);
    const tmp = node_path_1.default.join(dir, `.${node_path_1.default.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    await promises_1.default.writeFile(tmp, contents, "utf8");
    try {
        await promises_1.default.rename(tmp, targetPath);
    }
    catch (err) {
        // Best-effort cleanup of the tmpfile if the rename failed.
        promises_1.default.unlink(tmp).catch(() => { });
        throw err;
    }
}
function truncate(s) {
    const max = 4096;
    if (s.length <= max)
        return s;
    return s.slice(0, max) + `\n...[truncated, ${s.length - max} bytes omitted]`;
}
//# sourceMappingURL=configManager.js.map