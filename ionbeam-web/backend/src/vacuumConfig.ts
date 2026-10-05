import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Validate before saving any files; commit only the canonical Enable flag. */
export async function prepareVacuumEnabledUpdate(configPath: string, enabled: unknown): Promise<(() => Promise<boolean>) | null> {
  if (enabled === undefined) return null;
  if (typeof enabled !== "boolean") throw new Error("vacuum_enabled must be true or false");
  const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vacuum configuration must be a JSON object");
  }
  if (parsed.Enable === enabled) return async () => false;
  return async () => {
    const current = JSON.parse(await fsp.readFile(configPath, "utf8"));
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("vacuum configuration must be a JSON object");
    }
    current.Enable = enabled;
    const temporary = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temporary, JSON.stringify(current, null, 4) + "\n");
      await fsp.rename(temporary, configPath);
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
    return true;
  };
}

/**
 * UI availability is a configured feature flag, not a controller health
 * probe.  An enabled but temporarily unavailable SBC must remain visible so
 * the operator can inspect its error state and recover it.
 */
export function readVacuumEnabled(configPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      Enable?: unknown;
    };
    return parsed.Enable === true;
  } catch {
    return false;
  }
}
