/**
 * Vacuum readiness gates scanning only when the feature is enabled.
 * Authentication and an active scan remain independent panel locks.
 */
export function shouldDisableScanPanel({ scanActive, signedIn, vacuumEnabled, vacuumReady, }) {
    return scanActive || !signedIn || (vacuumEnabled && !vacuumReady);
}
export function shouldShowVacuumController(vacuumEnabled) {
    return vacuumEnabled;
}
