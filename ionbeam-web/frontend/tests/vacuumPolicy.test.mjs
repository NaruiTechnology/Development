import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldDisableScanPanel,
  vacuumIsReadyForControls,
  vacuumWindowState,
  shouldShowVacuumController,
  shouldShowVacuumControllerError,
  vacuumReadingsAreFresh,
  vacuumStatusForDisplay,
} from "../.test-dist/lib/vacuumPolicy.js";

const healthyVacuum = {
  connected: true, running: true, isVacuumSystemReady: true,
  cascade_stopped: false, last_error: null, alarms: [],
  updated_at: new Date().toISOString(), is_production: true, simulation: false,
};

test("vacuum icon shows an error for unknown, unavailable, stopped and faulted states", () => {
  assert.equal(shouldShowVacuumControllerError(null, null, null), true);
  for (const fault of [
    { connected: false }, { running: false }, { isVacuumSystemReady: false },
    { cascade_stopped: true }, { last_error: "SBC unavailable" }, { alarms: ["E-stop"] },
  ]) {
    assert.equal(shouldShowVacuumControllerError({ ...healthyVacuum, ...fault }, null, null), true);
  }
  assert.equal(shouldShowVacuumControllerError(healthyVacuum, "503 unavailable", null), true);
  assert.equal(shouldShowVacuumControllerError(healthyVacuum, "404 Not Found", null), true);
  assert.equal(shouldShowVacuumControllerError(healthyVacuum, null, "power"), true);
});

test("vacuum icon clears its error after a healthy recovery", () => {
  assert.equal(shouldShowVacuumControllerError(healthyVacuum, null, null), false);
});

test("stale or missing readings cannot make the vacuum icon healthy", () => {
  const now = Date.now();
  assert.equal(vacuumReadingsAreFresh(new Date(now - 5001).toISOString(), now), false);
  assert.equal(vacuumReadingsAreFresh(new Date(now - 5000).toISOString(), now), true);
  assert.equal(vacuumReadingsAreFresh(null, now), false);
  assert.equal(vacuumReadingsAreFresh("invalid", now), false);
  assert.equal(vacuumReadingsAreFresh(new Date(now + 2000).toISOString(), now), false);
  assert.equal(shouldShowVacuumControllerError({ ...healthyVacuum, updated_at: new Date(now - 6000).toISOString() }, null, null), true);
});

test("vacuum status policy is independent of scanner production mode", () => {
  assert.equal(shouldShowVacuumControllerError({ ...healthyVacuum, is_production: false }, null, null), false);
  assert.equal(shouldShowVacuumControllerError(healthyVacuum, null, null), false);
});

test("emulator pump-down is healthy while actual emulator faults remain visible", () => {
  const pumping = { ...healthyVacuum, is_production: false, isVacuumSystemReady: false };
  assert.equal(shouldShowVacuumControllerError(pumping, null, null), false);
  for (const fault of [{ connected: false }, { running: false },
    { cascade_stopped: true }, { last_error: "emulator fault" }, { alarms: ["E-stop"] }]) {
    assert.equal(shouldShowVacuumControllerError({ ...pumping, ...fault }, null, null), true);
  }
});

function panelDisabled(vacuumEnabled, vacuumReady, overrides = {}) {
  return shouldDisableScanPanel({
    scanActive: false,
    signedIn: true,
    vacuumEnabled,
    vacuumReady,
    ...overrides,
  });
}

test("disabled vacuum bypasses readiness and hides its controller", () => {
  assert.equal(panelDisabled(false, false), false);
  assert.equal(panelDisabled(false, true), false);
  assert.equal(shouldShowVacuumController(false), false);
});

test("enabled vacuum locks scanning until the system is ready", () => {
  assert.equal(panelDisabled(true, false), true);
  assert.equal(panelDisabled(true, true), false);
  assert.equal(shouldShowVacuumController(true), true);
});

test("runtime flag toggles update scan and controller policy in both directions", () => {
  const states = [
    { enabled: true, ready: false, panel: true, controller: true },
    { enabled: false, ready: false, panel: false, controller: false },
    { enabled: true, ready: false, panel: true, controller: true },
    { enabled: true, ready: true, panel: false, controller: true },
  ];

  for (const state of states) {
    assert.equal(panelDisabled(state.enabled, state.ready), state.panel);
    assert.equal(shouldShowVacuumController(state.enabled), state.controller);
  }
});

test("authentication and active scans still lock the panel independently", () => {
  assert.equal(panelDisabled(false, false, { signedIn: false }), true);
  assert.equal(panelDisabled(false, false, { scanActive: true }), true);
  assert.equal(panelDisabled(true, true, { signedIn: false }), true);
  assert.equal(panelDisabled(true, true, { scanActive: true }), true);
});

test("watchdog faults preserve the configured pump list while invalidating old readings", () => {
  const status = {
    ...healthyVacuum, connected: false, cascade_stopped: true,
    last_error: "control loop keep-alive expired", updated_at: "2000-01-01T00:00:00Z",
    pumps: ["MechanicalVacuumPump", "TurboVacuumPump", "UHVacuumPump_2"].map((name) => ({
      name, power: true, value: 0.001, ready: true, port_b_value: 3.3, border: "ready",
    })),
  };
  const shown = vacuumStatusForDisplay(status);
  assert.deepEqual(shown.pumps.map(p => p.name), status.pumps.map(p => p.name));
  assert.equal(shown.isVacuumSystemReady, false);
  assert.equal(shown.last_error, status.last_error);
  for (const pump of shown.pumps) {
    assert.equal(pump.value, null);
    assert.equal(pump.ready, false);
    assert.equal(pump.border, "error");
  }
  assert.equal(status.pumps[0].value, 0.001);
  assert.equal(vacuumStatusForDisplay({ ...status, connected: true }).connected, false);
});


test("startup locks controls until the service feature flag is known", () => {
  assert.equal(panelDisabled(null, false), true);
  assert.equal(panelDisabled(null, true), true);
});

test("simulation pump-down cannot unlock controls before initialization completes", () => {
  const simulated = { ...healthyVacuum, is_production: false, simulation: true };
  assert.equal(vacuumIsReadyForControls({ ...simulated, isVacuumSystemReady: false }), false);
  assert.equal(vacuumIsReadyForControls(simulated), true);
  assert.equal(vacuumIsReadyForControls(healthyVacuum), true);
  for (const fault of [{ connected: false }, { running: false }, { cascade_stopped: true },
    { last_error: "fault" }, { alarms: ["fault"] }, { updated_at: null }]) {
    assert.equal(vacuumIsReadyForControls({ ...simulated, ...fault }), false);
  }
});


test("vacuum window opens for any operating pump and minimizes at readiness", () => {
  const status = { ...healthyVacuum, isVacuumSystemReady: false,
    pumps: [{ power: false }, { power: true }] };
  assert.equal(vacuumWindowState(status), "pumping");
  assert.equal(vacuumWindowState({ ...status, pumps: [{ power: false }] }), "idle");
  assert.equal(vacuumWindowState({ ...status, isVacuumSystemReady: true }), "ready");
  assert.equal(vacuumWindowState({ ...status, is_production: false, simulation: true }), "pumping");
  assert.equal(vacuumWindowState({ ...status, connected: false }), null);
  assert.equal(vacuumWindowState({ ...status, updated_at: null }), null);
});
