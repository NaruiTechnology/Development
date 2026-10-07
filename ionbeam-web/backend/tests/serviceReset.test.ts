import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
for (const vacuumFails of [false, true]) {
  test(`server reset attempts all three services when vacuum startup ${vacuumFails ? "fails" : "succeeds"}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "service-reset-"));
    try {
      const calls = path.join(directory, "calls.txt");
      const systemctl = path.join(directory, "systemctl");
      // Stand-ins for systemctl and authorization eligibility. No real service
      // management or privilege escalation occurs in this test.
      await fs.writeFile(systemctl, String.raw`#!/bin/bash
printf '%s\n' "$*" >> "$TEST_CALLS"
if [[ "$TEST_VACUUM_FAILS" == true && "$*" == *is-active*sbc-vacuum.service* ]]; then exit 1; fi
`, { mode: 0o700 });
      await fs.writeFile(path.join(directory, "id"), String.raw`#!/bin/bash
if [[ "$1" == -un ]]; then echo test-admin; else echo sudo; fi
`, { mode: 0o700 });
      await fs.writeFile(path.join(directory, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
      let status = 0;
      try {
        await execute("/bin/bash", [path.resolve(__dirname, "../scripts/restart-glasgow-service.sh")], {
          env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, SYSTEMCTL_BIN: systemctl,
            TEST_CALLS: calls, TEST_VACUUM_FAILS: String(vacuumFails) }, timeout: 5000,
        });
      } catch (error: any) {
        status = error.code;
        assert.match(error.stderr, /sbc-vacuum.service.*did not remain active/s);
      }
      assert.equal(status, vacuumFails ? 1 : 0);
      const commands = (await fs.readFile(calls, "utf8")).trim().split("\n");
      assert.deepEqual(commands.filter((command) => command.includes(" restart ")), [
        "--no-ask-password restart glasgow-svc.service",
        "--user --no-ask-password restart sbc-vacuum.service",
        "--no-ask-password restart vacuum-executor.service",
      ]);
      assert.ok(commands.every((command) => command.includes("--no-ask-password")));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
