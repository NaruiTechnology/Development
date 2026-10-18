import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

// The SBC owns the vacuum system: the host reads vacuum data straight from
// the SBC (not through the host-side failover executor) and authenticates
// with the SBC's own token.

async function freePort(): Promise<number> {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((e) => e ? reject(e) : resolve()));
  return port;
}

test("the default vacuum target is the SBC itself", async () => {
  const saved = process.env.VACUUM_CONTROLLER_URL;
  delete process.env.VACUUM_CONTROLLER_URL;
  try {
    const { config } = await import("../src/config");
    assert.equal(config.vacuumControllerUrl, "http://127.0.0.1:8766");
  } finally {
    if (saved !== undefined) process.env.VACUUM_CONTROLLER_URL = saved;
  }
});

test("vacuum status is read from the SBC with the SBC token", { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vacuum-routing-"));
  const seen: { method?: string; url?: string; auth?: string }[] = [];
  const sbc = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: true, connected: true, pumps: [] }));
  });
  sbc.listen(0, "127.0.0.1");
  await once(sbc, "listening");
  const sbcPort = (sbc.address() as net.AddressInfo).port;
  const vacuum = path.join(directory, "vacuumSystem.json");
  await fs.writeFile(vacuum, JSON.stringify({ Enable: true }));
  await fs.writeFile(path.join(directory, "streamData.json"), JSON.stringify({ IsProduction: false }));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), MOCK: "true",
      GLASGOW_CONFIG: path.join(directory, "streamData.json"), SBC_VACUUM_CONFIG: vacuum,
      VACUUM_CONTROLLER_URL: `http://127.0.0.1:${sbcPort}`,
      SBC_VACUUM_TOKEN: "sbc-secret", GLASGOW_TOKEN: "glasgow-secret",
      IOBEAM_ADMIN_CONFIG: path.join(directory, "admin.json"),
      IOBEAM_SECRETS_FILE: path.join(directory, "secrets.env"),
      IOBEAM_ADMIN_DB_CONFIG: path.join(directory, "missing-db.json"),
      IOBEAM_ADMIN_DB_HOST: "127.0.0.1", IOBEAM_ADMIN_DB_PORT: "1",
      IOBEAM_OPERATION_DB_HOST: "127.0.0.1", IOBEAM_OPERATION_DB_PORT: "1",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/api/vacuum`); } catch { /* starting */ }
      if (response?.ok) break;
      if (child.exitCode !== null) throw new Error(`test backend exited: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(response?.ok, `vacuum status not served: ${output}`);
    assert.deepEqual(await response!.json(), { running: true, connected: true, pumps: [] });
    const request = seen.find((entry) => entry.url === "/vacuum");
    assert.ok(request, JSON.stringify(seen));
    assert.equal(request!.method, "GET");
    assert.equal(request!.auth, "Bearer sbc-secret");
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    sbc.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("an SBC with its own control disabled hides vacuum on the host", { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vacuum-disabled-"));
  const sbc = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "sbc-vacuum", vacuum_enabled: false, running: false }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "vacuum controller is disabled" }));
  });
  sbc.listen(0, "127.0.0.1");
  await once(sbc, "listening");
  const sbcPort = (sbc.address() as net.AddressInfo).port;
  const vacuum = path.join(directory, "vacuumSystem.json");
  await fs.writeFile(vacuum, JSON.stringify({ Enable: true }));   // host setting on
  await fs.writeFile(path.join(directory, "streamData.json"), JSON.stringify({ IsProduction: false }));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), MOCK: "true",
      GLASGOW_CONFIG: path.join(directory, "streamData.json"), SBC_VACUUM_CONFIG: vacuum,
      VACUUM_CONTROLLER_URL: `http://127.0.0.1:${sbcPort}`,
      IOBEAM_ADMIN_CONFIG: path.join(directory, "admin.json"),
      IOBEAM_SECRETS_FILE: path.join(directory, "secrets.env"),
      IOBEAM_ADMIN_DB_CONFIG: path.join(directory, "missing-db.json"),
      IOBEAM_ADMIN_DB_HOST: "127.0.0.1", IOBEAM_ADMIN_DB_PORT: "1",
      IOBEAM_OPERATION_DB_HOST: "127.0.0.1", IOBEAM_OPERATION_DB_PORT: "1",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    let status: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try { status = await fetch(`http://127.0.0.1:${port}/api/status`); } catch { /* starting */ }
      if (status?.ok) break;
      if (child.exitCode !== null) throw new Error(`test backend exited: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(status?.ok, output);
    assert.equal((await status!.json()).vacuum_enabled, false,
      "scan gate and dashboard must not wait for an SBC that does not control the vacuum");
    const config = await (await fetch(`http://127.0.0.1:${port}/api/admin/config`)).json();
    assert.equal(config.vacuum_enabled, true, "the host setting itself is unchanged");
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    sbc.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
