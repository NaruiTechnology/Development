import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareVacuumEnabledUpdate, readVacuumEnabled } from "../src/vacuumConfig";

test("Active vacuum control updates only Enable in the selected profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vacuum-enable-"));
  try {
    const selected = path.join(directory, "vacuumSystem.rpi5-io.example.json");
    const other = path.join(directory, "vacuumSystem.json");
    const profile = { Enable: true, IsProduction: false, Simulate: false,
      SBC: { Board: "RPi5VacuumIO-A" }, VacuumPumps: [{ name: "MechanicalVacuumPump" }] };
    await fs.writeFile(selected, JSON.stringify(profile));
    await fs.writeFile(other, JSON.stringify({ Enable: true }));
    const commit = await prepareVacuumEnabledUpdate(selected, false);
    assert.ok(commit);
    assert.equal(readVacuumEnabled(selected), true, "draft must not persist before Update");
    assert.equal(await commit(), true);
    assert.deepEqual(JSON.parse(await fs.readFile(selected, "utf8")), { ...profile, Enable: false });
    assert.equal(readVacuumEnabled(other), true);
    assert.equal(await (await prepareVacuumEnabledUpdate(selected, false))!(), false);
    assert.equal(await (await prepareVacuumEnabledUpdate(selected, true))!(), true);
    assert.equal(readVacuumEnabled(selected), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("invalid or omitted vacuum flag never changes the configuration", async () => {
  assert.equal(await prepareVacuumEnabledUpdate("missing.json", undefined), null);
  await assert.rejects(prepareVacuumEnabledUpdate("missing.json", "true"), /must be true or false/);
  assert.equal(readVacuumEnabled("missing.json"), false);
});
