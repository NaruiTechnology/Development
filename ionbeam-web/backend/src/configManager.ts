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
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { config } from "./config";

const execAsync = promisify(exec);

/** Suffix appended to derive the backup filename next to the live config. */
const BACKUP_SUFFIX = "_default.json";

/** Max bytes accepted on a config write. Generous — the real file is ~6 KB. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** How long to wait for the restart command before giving up. */
const RESTART_TIMEOUT_MS = 30_000;

export interface ConfigInfo {
  /** Absolute path to the live config file. */
  path: string;
  /** Absolute path to the backup file (whether or not it exists). */
  backup_path: string;
  /** Parsed JSON contents (any shape — we don't enforce a schema here). */
  data: unknown;
  /** True if the backup file currently exists on disk. */
  has_backup: boolean;
  /** True if backup was just created on this call (lazy bootstrap path). */
  backup_created: boolean;
}

export interface RestartResult {
  ok: boolean;
  command: string;
  /** stdout from the restart command, truncated for safety. */
  stdout?: string;
  /** stderr from the restart command, truncated for safety. */
  stderr?: string;
  /** Set if the restart command itself failed to spawn or non-zero exited. */
  error?: string;
}

export class ConfigError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "ConfigError";
  }
}

/**
 * Derive the backup path from the live path. Always lives next to the
 * source so a single directory move keeps both files together.
 *
 *   /a/b/streamData.json  ->  /a/b/streamData_default.json
 *   /a/b/foo.json         ->  /a/b/foo_default.json
 *   /a/b/foo              ->  /a/b/foo_default.json
 */
export function backupPathFor(configPath: string): string {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, `${stem}${BACKUP_SUFFIX}`);
}

/**
 * Read the live config, parse it, and ensure the backup exists. The
 * first time we touch a fresh install this also creates the backup as
 * a verbatim copy of the live file, which is the documented invariant
 * the "Default" button relies on.
 */
export async function readWithBackup(): Promise<ConfigInfo> {
  const configPath = config.configPath;
  const backupPath = backupPathFor(configPath);

  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new ConfigError(
        `config file not found: ${configPath}`,
        404
      );
    }
    throw new ConfigError(
      `failed to read config file ${configPath}: ${err.message}`,
      500
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    throw new ConfigError(
      `config file is not valid JSON: ${err.message}`,
      500
    );
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
    } catch (err: any) {
      // Don't fail the whole read just because we couldn't create the
      // backup (most likely a permission issue). Surface has_backup=false
      // and let the UI disable the Default button.
      console.warn(
        `[configManager] failed to create backup at ${backupPath}: ${err.message}`
      );
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
export async function writeConfig(data: unknown): Promise<void> {
  const configPath = config.configPath;

  // Reject silly-large payloads up front. The Express body parser is
  // already capped at 16 MB; this is a tighter check on what we'll
  // actually accept for a config write specifically.
  const serialized = JSON.stringify(data, null, 4) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new ConfigError(
      `config payload too large (>${MAX_CONFIG_BYTES} bytes)`,
      413
    );
  }

  if (config.configStrict) {
    if (!(await fileExists(configPath))) {
      throw new ConfigError(
        `strict mode: config file does not exist: ${configPath}`,
        404
      );
    }
  } else {
    // Make sure the directory exists. The python side won't have done
    // this for us if the dialog is being used on a bare install.
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
  }

  await atomicWrite(configPath, serialized);
}

/**
 * Replace the live config with a verbatim copy of the backup. Throws
 * if the backup is missing (the UI should keep the button disabled in
 * that case, but the check is defensive against a stale page state).
 */
export async function restoreFromBackup(): Promise<void> {
  const configPath = config.configPath;
  const backupPath = backupPathFor(configPath);

  let raw: string;
  try {
    raw = await fsp.readFile(backupPath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new ConfigError(
        `no backup to restore from: ${backupPath}`,
        404
      );
    }
    throw new ConfigError(
      `failed to read backup file ${backupPath}: ${err.message}`,
      500
    );
  }

  // Validate the backup is still parseable. If somebody hand-edited the
  // _default.json into something invalid, restoring it would just break
  // the service — better to bail with a clear error.
  try {
    JSON.parse(raw);
  } catch (err: any) {
    throw new ConfigError(
      `backup file is not valid JSON: ${err.message}`,
      500
    );
  }

  await atomicWrite(configPath, raw);
}

/**
 * Execute the configured restart command. We don't throw on a non-zero
 * exit — the file write already succeeded and we want the caller to
 * be able to surface the restart failure to the operator (who may need
 * to restart the service manually).
 */
export async function restartService(): Promise<RestartResult> {
  const command = config.restartCmd;
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
  } catch (err: any) {
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write to a tmpfile in the same directory then rename. fs.rename is
 * atomic within a filesystem, so a power-loss / crash during the write
 * can't leave a half-written config behind.
 */
async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fsp.writeFile(tmp, contents, "utf8");
  try {
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmpfile if the rename failed.
    fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

function truncate(s: string): string {
  const max = 4096;
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated, ${s.length - max} bytes omitted]`;
}
