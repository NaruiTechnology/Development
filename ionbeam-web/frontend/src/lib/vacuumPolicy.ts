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
    || (status.is_production !== false && status.isVacuumSystemReady !== true)
    || status.cascade_stopped === true
    || Boolean(status.last_error) || (status.alarms?.length ?? 0) > 0
    || !vacuumReadingsAreFresh(status.updated_at);
}

/** Controls require completed initialization in both hardware and simulation modes. */
export function vacuumIsReadyForControls(status: VacuumSystemStatus): boolean {
  return status.isVacuumSystemReady === true
    && !shouldShowVacuumControllerError(status, null, null);
}

export interface VacuumUiPolicyInput {
  scanActive: boolean;
  signedIn: boolean;
  vacuumEnabled: boolean | null;
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
  return scanActive || !signedIn || vacuumEnabled === null || (vacuumEnabled && !vacuumReady);
}

export function shouldShowVacuumController(vacuumEnabled: boolean): boolean {
  return vacuumEnabled;
}

/** Preserve configured equipment during faults without displaying stale readings. */
export function vacuumStatusForDisplay(status: VacuumSystemStatus, now = Date.now()): VacuumSystemStatus {
  if (status.connected && vacuumReadingsAreFresh(status.updated_at, now)) return status;
  return {
    ...status, connected: false, isVacuumSystemReady: false,
    pumps: status.pumps.map((pump) => ({
      ...pump, value: null, ready: false, port_b_value: 0,
      border: pump.power ? "error" : "off",
    })),
  };
}
