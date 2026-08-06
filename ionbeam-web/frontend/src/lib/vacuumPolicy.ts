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
