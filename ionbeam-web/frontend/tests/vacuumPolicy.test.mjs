import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldDisableScanPanel,
  shouldShowVacuumController,
} from "../.test-dist/lib/vacuumPolicy.js";

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
