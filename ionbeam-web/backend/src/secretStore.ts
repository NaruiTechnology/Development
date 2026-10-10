/**
 * Runtime secret resolution for JSON configuration.
 *
 * Mirrors Development/secretstore/__init__.py (same file, same rules; the
 * Python test-suite checks both against tests/fixtures/secretstore-cases.json).
 *
 * A JSON value such as "${IOBEAM_FTP_PASSWORD}" or "${NAME:-default}" is
 * resolved from, in order: process.env[NAME], the file named by NAME_FILE,
 * and the secrets file ($IOBEAM_SECRETS_FILE or
 * $XDG_CONFIG_HOME/iobeam/secrets.env, default ~/.config/iobeam/secrets.env).
 * The file uses systemd EnvironmentFile= syntax and must be mode 600.
 *
 * Tracked JSON keeps only placeholders. When the settings UI saves a literal
 * credential, externalizeSecrets() moves it into the secrets file and stores
 * the placeholder instead, so a password typed in the UI never lands in a
 * file that is committed, backed up as *_default.json, or packaged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const FULL_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export class SecretError extends Error {}

export type KeyPath = ReadonlyArray<string | number>;
export interface SecretBinding {
  path: KeyPath;
  name: string;
}

const FTP_PATH = ["Actions", 0, "streamData", "actionData", "ftp"] as const;

/** streamData.json credentials (Settings -> Admin -> FTP). */
export const STREAM_SECRET_BINDINGS: SecretBinding[] = [
  { path: [...FTP_PATH, "host"], name: "IOBEAM_FTP_HOST" },
  { path: [...FTP_PATH, "username"], name: "IOBEAM_FTP_USER" },
  { path: [...FTP_PATH, "password"], name: "IOBEAM_FTP_PASSWORD" },
];

/**
 * IobeamAdmin.json credentials (Settings -> Admin -> Database): the admin
 * connection the app queries. Distinct from IOBEAM_ADMIN_DB_* (the local
 * runtime role in IobeamAdminDb.json, used as the fallback connection).
 */
export const ADMIN_SECRET_BINDINGS: SecretBinding[] = [
  { path: ["Database", "Host"], name: "IOBEAM_ADMIN_CONFIG_DB_HOST" },
  { path: ["Database", "User"], name: "IOBEAM_ADMIN_CONFIG_DB_USER" },
  { path: ["Database", "Password"], name: "IOBEAM_ADMIN_CONFIG_DB_PASSWORD" },
  { path: ["Database", "ConnectionString"], name: "IOBEAM_ADMIN_CONFIG_DB_URL" },
];

export function defaultSecretsPath(): string {
  const configured = process.env.IOBEAM_SECRETS_FILE?.trim();
  if (configured) return path.resolve(expandHome(configured));
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "iobeam", "secrets.env");
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function unquote(raw: string, lineNumber: number): string {
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")) {
    const inner = raw.slice(1, -1);
    return raw[0] === "'" ? inner : inner.replace(/\\(["\\$`])/g, "$1");
  }
  if (raw.startsWith('"') || raw.startsWith("'")) {
    throw new SecretError(`secrets file line ${lineNumber}: unterminated quote`);
  }
  return raw;
}

export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const number = index + 1;
    if (!line || line.startsWith("#") || line.startsWith(";")) return;
    if (line.startsWith("export ")) {
      throw new SecretError(`secrets file line ${number}: remove 'export' (systemd cannot read it)`);
    }
    const match = LINE.exec(line);
    if (!match) throw new SecretError(`secrets file line ${number} is not KEY=VALUE`);
    values[match[1]] = unquote(match[2].trim(), number);
  });
  return values;
}

let cache: { file: string; mtimeMs: number; values: Record<string, string> } | null = null;

export function readSecretsFile(file: string = defaultSecretsPath()): Record<string, string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.values;
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new SecretError(
      `secrets file ${file} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
    );
  }
  const values = parseEnv(fs.readFileSync(file, "utf8"));
  cache = { file, mtimeMs: stat.mtimeMs, values };
  return values;
}

export function getSecret(name: string, fallback: string | null = null): string | null {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv;
  const reference = process.env[`${name}_FILE`];
  if (reference) return fs.readFileSync(expandHome(reference), "utf8").replace(/[\r\n]+$/, "");
  const fromFile = readSecretsFile()[name];
  return fromFile !== undefined ? fromFile : fallback;
}

/** Export secrets-file values that are not already set in process.env. */
export function loadSecretsIntoEnv(): void {
  try {
    for (const [name, value] of Object.entries(readSecretsFile())) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  } catch (err) {
    // Fail closed on an unsafe file, but never crash the import of config.ts
    // with an unhelpful stack: log once and continue without file values.
    console.error(`[secrets] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && FULL_PLACEHOLDER.test(value);
}

/**
 * Recursively resolve placeholders. With strict=false an unresolved required
 * placeholder resolves to "" so callers treat it as "not configured".
 */
export function expandPlaceholders<T>(value: T, strict = false, source = "configuration"): T {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
      const found = getSecret(name);
      // Shell semantics: ":-" also applies when the value is empty.
      const resolved = !found && fallback !== undefined ? fallback : found;
      if (resolved !== null) return resolved;
      if (strict) {
        throw new SecretError(`${source} references \${${name}}, which is not set in ${defaultSecretsPath()}`);
      }
      return "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => expandPlaceholders(item, strict, source)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandPlaceholders(item, strict, source);
    }
    return out as T;
  }
  return value;
}

function quote(value: string): string {
  if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Insert/replace variables in the secrets file (dir 0700, file 0600, atomic).
 * With overwrite=false, variables that already have a value are left alone.
 */
export function writeSecrets(
  updates: Record<string, string>,
  file: string = defaultSecretsPath(),
  overwrite = true,
): string[] {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lines: string[];
  let current: Record<string, string>;
  try {
    const text = fs.readFileSync(file, "utf8");
    lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    current = parseEnv(text);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    lines = [
      "# Iobeam runtime secrets. Never commit or copy into a distribution.",
      "# Managed with: python3 -m secretstore {set,list,check}",
    ];
    current = {};
  }
  const written: string[] = [];
  for (const [name, rawValue] of Object.entries(updates)) {
    if (!NAME.test(name)) throw new SecretError(`invalid variable name: ${name}`);
    const value = String(rawValue ?? "");
    if (/[\r\n]/.test(value)) throw new SecretError(`${name} contains a newline`);
    if (current[name] === value) continue;
    if (!overwrite && current[name] !== undefined && current[name] !== "") continue;
    const entry = `${name}=${quote(value)}`;
    const index = lines.findIndex((line) => line.trim().startsWith(`${name}=`));
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
    current[name] = value;
    written.push(name);
  }
  if (written.length === 0) return written;
  const temporary = path.join(dir, `.secrets.${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  cache = null;
  // The running process loaded the file into process.env at start-up (and
  // systemd's EnvironmentFile= does the same), so update it too: a password
  // changed in the Settings dialog takes effect without a restart.
  if (file === defaultSecretsPath()) {
    for (const name of written) process.env[name] = current[name];
  }
  return written;
}

function readPath(data: unknown, keys: KeyPath): unknown {
  let current = data;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function writePathInPlace(data: unknown, keys: KeyPath, value: unknown): void {
  let current = data as Record<string | number, unknown>;
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string | number, unknown>;
  current[keys[keys.length - 1]] = value;
}

export interface ExternalizeOptions {
  /** Replace values already in the secrets file (true for explicit saves). */
  overwrite?: boolean;
  /**
   * Only move logins, passwords and connection strings, leaving host names
   * in place. Used by the automatic migration of existing files and backups,
   * so a default such as "Host": "localhost" in a *_default.json is not
   * rewritten (or pushed into the secrets file) just by being read.
   */
  credentialsOnly?: boolean;
}

function isHostBinding(name: string): boolean {
  return name.endsWith("_HOST");
}

/**
 * Move literal credentials from `data` into the secrets file and return a
 * copy holding placeholders. Empty strings and existing placeholders are kept
 * as they are.
 */
export function externalizeSecrets<T>(
  data: T,
  bindings: SecretBinding[],
  { overwrite = true, credentialsOnly = false }: ExternalizeOptions = {},
): T {
  const copy = JSON.parse(JSON.stringify(data)) as T;
  const updates: Record<string, string> = {};
  for (const { path: keys, name } of bindings) {
    if (credentialsOnly && isHostBinding(name)) continue;
    const value = readPath(copy, keys);
    if (typeof value !== "string" || !value.trim() || isPlaceholder(value)) continue;
    updates[name] = value.trim();
    writePathInPlace(copy, keys, name.endsWith("_URL") ? `\${${name}:-}` : `\${${name}}`);
  }
  if (Object.keys(updates).length > 0) writeSecrets(updates, defaultSecretsPath(), overwrite);
  return copy;
}
