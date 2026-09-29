import fs from "node:fs";

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
