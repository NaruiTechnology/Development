import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostVacuumSettingsPath, prepareVacuumEnabledUpdate, readVacuumEnabled } from "../src/vacuumConfig";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vacuum-enable-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("Active vacuum control is a host setting and never writes the SBC profile", async () => {
  await withDirectory(async (directory) => {
    const profile = path.join(directory, "vacuumSystem.rpi5-io.example.json");
    const original = JSON.stringify({ Enable: true, IsProduction: false, Simulate: false,
      SBC: { Board: "RPi5VacuumIO-A" }, VacuumPumps: [{ name: "MechanicalVacuumPump" }] });
    await fs.writeFile(profile, original);
    const hostFile = hostVacuumSettingsPath(profile);
    assert.equal(hostFile, path.join(directory, "vacuumHost.json"));

    // Legacy: before the host saves its own setting, the profile flag is read.
    assert.equal(readVacuumEnabled(profile), true);
    const commit = await prepareVacuumEnabledUpdate(profile, false);
    assert.ok(commit);
    assert.equal(readVacuumEnabled(profile), true, "draft must not persist before Update");
    assert.equal(await commit(), true);
    assert.equal(readVacuumEnabled(profile), false);
    assert.deepEqual(JSON.parse(await fs.readFile(hostFile, "utf8")), { Enable: false });
    assert.equal(await fs.readFile(profile, "utf8"), original, "the SBC profile is never modified");

    assert.equal(await (await prepareVacuumEnabledUpdate(profile, false))!(), false);
    assert.equal(await (await prepareVacuumEnabledUpdate(profile, true))!(), true);
    assert.equal(readVacuumEnabled(profile), true);
    assert.equal(await fs.readFile(profile, "utf8"), original);
  });
});

test("VACUUM_HOST_CONFIG moves the host setting", async () => {
  await withDirectory(async (directory) => {
    const profile = path.join(directory, "vacuumSystem.json");
    await fs.writeFile(profile, JSON.stringify({ Enable: false }));
    const override = path.join(directory, "host", "vacuum.json");
    process.env.VACUUM_HOST_CONFIG = override;
    try {
      assert.equal(hostVacuumSettingsPath(profile), override);
      await (await prepareVacuumEnabledUpdate(profile, true))!();
      assert.equal(readVacuumEnabled(profile), true);
      assert.deepEqual(JSON.parse(await fs.readFile(override, "utf8")), { Enable: true });
      assert.deepEqual(JSON.parse(await fs.readFile(profile, "utf8")), { Enable: false });
    } finally {
      delete process.env.VACUUM_HOST_CONFIG;
    }
  });
});

test("invalid or omitted vacuum flag never changes the configuration", async () => {
  assert.equal(await prepareVacuumEnabledUpdate("missing.json", undefined), null);
  await assert.rejects(prepareVacuumEnabledUpdate("missing.json", "true"), /must be true or false/);
  assert.equal(readVacuumEnabled("missing.json"), false);
});

test("the host follows the SBC: vacuum is on only when the SBC also enables it", async () => {
  const { readEffectiveVacuumEnabled, resetSbcStatusCache } = await import("../src/vacuumConfig");
  await withDirectory(async (directory) => {
    const profile = path.join(directory, "vacuumSystem.json");
    await fs.writeFile(profile, JSON.stringify({ Enable: true }));
    const calls: string[] = [];
    const probeWith = (answer: boolean | null) => async (url: string) => {
      calls.push(url);
      return answer;
    };
    resetSbcStatusCache();
    assert.equal(await readEffectiveVacuumEnabled(profile, "http://sbc-a", null, probeWith(true)), true);
    resetSbcStatusCache();
    assert.equal(await readEffectiveVacuumEnabled(profile, "http://sbc-a", null, probeWith(false)), false,
      "an SBC that disabled its own control hides vacuum on the host");
    resetSbcStatusCache();
    assert.equal(await readEffectiveVacuumEnabled(profile, "http://sbc-a", null, probeWith(null)), true,
      "an unreachable SBC stays visible so the operator sees it is down");

    // Host setting off: the SBC is not even asked.
    await (await prepareVacuumEnabledUpdate(profile, false))!();
    resetSbcStatusCache();
    calls.length = 0;
    assert.equal(await readEffectiveVacuumEnabled(profile, "http://sbc-a", null, probeWith(true)), false);
    assert.deepEqual(calls, []);

    // The SBC answer is cached briefly (the UI polls status often).
    await (await prepareVacuumEnabledUpdate(profile, true))!();
    resetSbcStatusCache();
    await readEffectiveVacuumEnabled(profile, "http://sbc-b", null, probeWith(false));
    await readEffectiveVacuumEnabled(profile, "http://sbc-b", null, probeWith(false));
    assert.equal(calls.length, 1);
  });
});
