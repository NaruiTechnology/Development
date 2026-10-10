import test from "node:test";
import assert from "node:assert/strict";
import reducer, { fetchSettingsConfig, saveSettingsConfig, setDraftVacuumEnabled, resetDraft, closeDialog }
  from "../../frontend/src/store/settingsSlice";

function loadedSettings() {
  return reducer(undefined, fetchSettingsConfig.fulfilled({
    path: "streamData.json", backup_path: "streamData_default.json", has_backup: true,
    data: { IsProduction: true }, vacuum_enabled: true,
  }, "load"));
}

test("vacuum switch has its own persisted draft and supports discard", () => {
  const loaded = loadedSettings();
  const changed = reducer(loaded, setDraftVacuumEnabled(false));
  assert.equal(changed.sourceVacuumEnabled, true);
  assert.equal(changed.draftVacuumEnabled, false);
  assert.equal(changed.draft, changed.source, "vacuum switch must not modify streamData.json");
  assert.equal(reducer(changed, resetDraft()).draftVacuumEnabled, true);
  assert.equal(reducer(changed, closeDialog()).draftVacuumEnabled, true);
});

test("Update promotes the saved vacuum flag independently of scanner production", () => {
  const changed = reducer(loadedSettings(), setDraftVacuumEnabled(false));
  const saved = reducer(changed, saveSettingsConfig.fulfilled({
    ok: true, restart: { ok: true, command: "restart" },
  }, "save", changed.draft));
  assert.equal(saved.sourceVacuumEnabled, false);
  assert.equal(saved.draftVacuumEnabled, false);
  assert.equal((saved.source as { IsProduction: boolean }).IsProduction, true);
});
