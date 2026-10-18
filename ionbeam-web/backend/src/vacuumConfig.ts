import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/*
 * "Active vacuum control" is a HOST setting: it decides whether this host
 * shows and uses the SBC vacuum controller (vacuum dashboard, vacuum scan
 * gate). It never writes the SBC's own vacuum profile. The SBC owns the
 * vacuum system and decides from its own profile whether and how it
 * controls the pumps; the host only reads the SBC's status.
 *
 * The setting lives in VACUUM_HOST_CONFIG (default: vacuumHost.json beside
 * the SBC profile). Until the host saves it for the first time, the legacy
 * Enable flag of the SBC profile is read, read-only, so an existing
 * installation keeps its current setting.
 */

/** Where the host keeps its own vacuum UI setting. */
export function hostVacuumSettingsPath(configPath: string): string {
  const override = process.env.VACUUM_HOST_CONFIG?.trim();
  return override ? override : path.join(path.dirname(configPath), "vacuumHost.json");
}

function readEnableFlag(file: string): boolean | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { Enable?: unknown };
    return typeof parsed?.Enable === "boolean" ? parsed.Enable : undefined;
  } catch {
    return undefined;
  }
}

/** Validate before saving any files; the commit writes only the host setting. */
export async function prepareVacuumEnabledUpdate(configPath: string, enabled: unknown): Promise<(() => Promise<boolean>) | null> {
  if (enabled === undefined) return null;
  if (typeof enabled !== "boolean") throw new Error("vacuum_enabled must be true or false");
  if (readVacuumEnabled(configPath) === enabled) return async () => false;
  const hostPath = hostVacuumSettingsPath(configPath);
  return async () => {
    let current: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(hostPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch {
      // First save, or an unreadable file that this save replaces.
    }
    current.Enable = enabled;
    await fsp.mkdir(path.dirname(hostPath), { recursive: true });
    const temporary = path.join(path.dirname(hostPath), `.${path.basename(hostPath)}.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(temporary, JSON.stringify(current, null, 4) + "\n");
      await fsp.rename(temporary, hostPath);
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
    return true;
  };
}

/**
 * UI availability is a configured host setting, not a controller health
 * probe. An enabled but temporarily unavailable SBC must remain visible so
 * the operator can inspect its error state.
 */
export function readVacuumEnabled(configPath: string): boolean {
  const host = readEnableFlag(hostVacuumSettingsPath(configPath));
  if (host !== undefined) return host;
  return readEnableFlag(configPath) === true;
}

/*
 * The SBC owns the vacuum system, including whether it controls it at all
 * (Enable in its own profile). The host shows the vacuum dashboard and
 * applies the vacuum scan gate only when BOTH the host setting is on AND
 * the SBC reports that its control is enabled. An SBC that cannot be
 * reached stays "enabled" (when the host setting is on), so the operator
 * sees it is down instead of the vacuum silently disappearing.
 */
type SbcStatusProbe = (url: string, token: string | null) => Promise<boolean | null>;

let sbcCache: { url: string; at: number; value: boolean | null } | null = null;
const SBC_STATUS_CACHE_MS = 2_000;

/** The SBC's own vacuum_enabled, or null when it cannot be read. */
export const probeSbcVacuumEnabled: SbcStatusProbe = async (url, token) => {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const status = (await response.json()) as { vacuum_enabled?: unknown };
    return typeof status?.vacuum_enabled === "boolean" ? status.vacuum_enabled : null;
  } catch {
    return null;
  }
};

export async function readEffectiveVacuumEnabled(
  configPath: string,
  sbcUrl: string,
  token: string | null,
  probe: SbcStatusProbe = probeSbcVacuumEnabled,
): Promise<boolean> {
  if (!readVacuumEnabled(configPath)) return false;
  const now = Date.now();
  let sbcEnabled: boolean | null;
  if (sbcCache && sbcCache.url === sbcUrl && now - sbcCache.at < SBC_STATUS_CACHE_MS) {
    sbcEnabled = sbcCache.value;
  } else {
    sbcEnabled = await probe(sbcUrl, token);
    sbcCache = { url: sbcUrl, at: now, value: sbcEnabled };
  }
  return sbcEnabled !== false;
}

/** Tests only. */
export function resetSbcStatusCache(): void {
  sbcCache = null;
}
