import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Exercise the real HTTP endpoint with temporary configuration and a harmless
// restart command. Never use the deployed services, credentials or database.
test("Update resets on mode changes and unchanged configuration; invalid saves do not reset", { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "config-reset-"));
  const stream = path.join(directory, "streamData.json");
  const vacuum = path.join(directory, "vacuum.json");
  const counter = path.join(directory, "resets.txt");
  const reset = path.join(directory, "reset.cjs");
  await fs.writeFile(stream, JSON.stringify({ IsProduction: false, Actions: [] }));
  await fs.writeFile(vacuum, JSON.stringify({ Enable: true }));
  await fs.writeFile(reset, String.raw`require("node:fs").appendFileSync(process.env.TEST_RESET_COUNTER, "reset\n");`);
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), MOCK: "true",
      GLASGOW_CONFIG: stream, SBC_VACUUM_CONFIG: vacuum,
      IOBEAM_ADMIN_CONFIG: path.join(directory, "admin.json"),
      IOBEAM_SECRETS_FILE: path.join(directory, "secrets.env"),
      IOBEAM_ADMIN_DB_CONFIG: path.join(directory, "missing-db.json"),
      IOBEAM_ADMIN_DB_HOST: "127.0.0.1", IOBEAM_ADMIN_DB_PORT: "1",
      IOBEAM_OPERATION_DB_HOST: "127.0.0.1", IOBEAM_OPERATION_DB_PORT: "1",
      GLASGOW_RESTART_CMD: `"${process.execPath}" "${reset}"`,
      TEST_RESET_COUNTER: counter, IONBEAM_BACKEND_RESTART_AFTER_GLASGOW: "false",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const url = `http://127.0.0.1:${port}/api/admin/config`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(url)).ok; } catch { /* process is starting */ }
      if (ready) break;
      if (child.exitCode !== null) throw new Error(`test backend exited: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `test backend did not become ready: ${output}`);
    const updates = [
      { production: false, enabled: true }, // unchanged: recover a fault
      { production: true, enabled: true },
      { production: true, enabled: true }, // unchanged production reset
      { production: false, enabled: true },
      { production: false, enabled: false },
      { production: false, enabled: false },
    ];
    for (const [index, update] of updates.entries()) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { IsProduction: update.production, Actions: [] }, vacuum_enabled: update.enabled }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.restart.ok, true, JSON.stringify(body));
      assert.notEqual(body.restart.skipped, true);
      assert.equal(body.backend_restart.scheduled, false);
      assert.equal((await fs.readFile(counter, "utf8")).trim().split("\n").length, index + 1);
      assert.equal(JSON.parse(await fs.readFile(stream, "utf8")).IsProduction, update.production);
      assert.equal(JSON.parse(await fs.readFile(vacuum, "utf8")).Enable, update.enabled);
    }
    const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { IsProduction: true }, vacuum_enabled: "true" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await fs.readFile(counter, "utf8")).trim().split("\n").length, updates.length);
    assert.equal(JSON.parse(await fs.readFile(stream, "utf8")).IsProduction, false);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
