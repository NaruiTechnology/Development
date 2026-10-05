import type { VacuumSystemStatus } from "../types/api";

export function vacuumReadingsAreFresh(updatedAt: string | null, now = Date.now()): boolean {
  if (!updatedAt) return false;
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && now - timestamp <= 5000 && timestamp - now <= 1000;
}

/** Unknown, failed, or incomplete vacuum state marks the header icon. */
export function shouldShowVacuumControllerError(
  status: Pick<VacuumSystemStatus, "connected" | "running" | "isVacuumSystemReady" | "cascade_stopped" | "last_error" | "alarms" | "updated_at" | "is_production" | "simulation"> | null,
  error: string | null,
  pending: string | null,
): boolean {
  return pending !== null || error !== null || status === null
    || status.connected !== true || status.running !== true
    || status.isVacuumSystemReady !== true || status.cascade_stopped === true
    || Boolean(status.last_error) || (status.alarms?.length ?? 0) > 0
    || !vacuumReadingsAreFresh(status.updated_at);
}

export interface VacuumUiPolicyInput {
  scanActive: boolean;
  signedIn: boolean;
  vacuumEnabled: boolean;
  vacuumReady: boolean;
}

/**
 * Vacuum readiness gates scanning only when the feature is enabled.
 * Authentication and an active scan remain independent panel locks.
 */
export function shouldDisableScanPanel({
  scanActive,
  signedIn,
  vacuumEnabled,
  vacuumReady,
}: VacuumUiPolicyInput): boolean {
  return scanActive || !signedIn || (vacuumEnabled && !vacuumReady);
}

export function shouldShowVacuumController(vacuumEnabled: boolean): boolean {
  return vacuumEnabled;
}
