import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {WebSocket, WebSocketServer} from "ws";
import {config} from "../src/config";
import {attachWsProxy} from "../src/wsProxy";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";

test("real backend defaults advertise persistent exposure capability", {timeout: 20000}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "exposure-defaults-"));
  const upstream = createServer((_req, res) => {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({exposure_cell_ranges: true, raster: {}, vector: {}}));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as {port: number}).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await writeFile(path.join(directory, "stream.json"), JSON.stringify({IsProduction: false}));
  await writeFile(path.join(directory, "vacuum.json"), JSON.stringify({Enable: false}));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: {...process.env, PORT: String(port), MOCK: "false",
      PROXY_TARGET_HTTP: `http://127.0.0.1:${(upstream.address() as {port: number}).port}`,
      GLASGOW_CONFIG: path.join(directory, "stream.json"), SBC_VACUUM_CONFIG: path.join(directory, "vacuum.json"),
      IOBEAM_ADMIN_CONFIG: path.join(directory, "admin.json"), IOBEAM_SECRETS_FILE: path.join(directory, "secrets.env"),
      IOBEAM_ADMIN_DB_CONFIG: path.join(directory, "missing-db.json"),
      IOBEAM_ADMIN_DB_HOST: "127.0.0.1", IOBEAM_ADMIN_DB_PORT: "1",
      IOBEAM_OPERATION_DB_HOST: "127.0.0.1", IOBEAM_OPERATION_DB_PORT: "1"},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/api/defaults`); } catch {}
      if (response?.ok) break;
      if (child.exitCode !== null) throw new Error(`test backend exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(response?.ok, output);
    const defaults = await response!.json();
    assert.equal(defaults.exposure_cell_ranges, true, "upstream metadata is preserved");
    assert.equal(defaults.exposure_session_stream, true, "capability belongs on /api/defaults");
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});

async function sessionFixture(action: (url: string, source: WebSocketServer, authCount: () => number) => Promise<void>) {
  const upstream = createServer();
  const source = new WebSocketServer({server: upstream});
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const previous = {target: config.proxyTargetWs, mock: config.mock};
  config.proxyTargetWs = `ws://127.0.0.1:${(upstream.address() as {port: number}).port}`;
  config.mock = false;
  const proxy = createServer();
  let authorizations = 0;
  attachWsProxy(proxy, async () => ++authorizations === 1 ? {ok: true} :
    {ok: false, status: 401, message: "token expired after run start"});
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    await action(`ws://127.0.0.1:${(proxy.address() as {port: number}).port}/ws/exposure/session`, source, () => authorizations);
  } finally {
    for (const socket of source.clients) socket.terminate();
    config.proxyTargetWs = previous.target; config.mock = previous.mock;
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => source.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}

test("one authorization covers consecutive exposure segments and View", {timeout: 8000}, async () => {
  await sessionFixture(async (url, source, authCount) => {
    const requests: any[] = [];
    source.on("connection", socket => socket.once("message", raw => {
      requests.push(JSON.parse(raw.toString()));
      socket.send(Buffer.from([1, 2]), {binary: true});
      socket.send(JSON.stringify({event: "done"}));
      // Intentionally omit server close: the proxy must complete the handshake.
    }));
    const client = new WebSocket(url);
    try {
      await once(client, "open");
      for (const request of [{pattern: "lattice", lattice: {cell_start: 0}},
        {pattern: "lattice", lattice: {cell_start: 100}}, {exposure_view: true, resolution: 1}]) {
        const messages: Array<{data: Buffer; binary: boolean}> = [];
        const complete = new Promise<void>(resolve => {
          const receive = (data: any, binary: boolean) => {
            messages.push({data: Buffer.from(data), binary});
            if (!binary && JSON.parse(data.toString()).event === "done") {
              client.off("message", receive); resolve();
            }
          };
          client.on("message", receive);
        });
        client.send(JSON.stringify({kind: "pattern" in request ? "vector" : "raster", request}));
        await complete;
        assert.equal(messages.length, 2);
        assert.equal(messages[0].binary, true);
        assert.equal(messages[1].binary, false);
      }
      assert.equal(requests.length, 3);
      assert.equal(requests[1].lattice.cell_start, 100);
      assert.equal(authCount(), 1, "session expiry cannot trigger another upgrade mid-run");
    } finally { client.terminate(); }
  });
});

test("uncertain upstream completion fails the session without replay", {timeout: 8000}, async () => {
  await sessionFixture(async (url, source) => {
    let requests = 0;
    source.on("connection", socket => socket.once("message", () => {
      requests++; socket.send(Buffer.from([1, 2])); socket.terminate();
    }));
    const client = new WebSocket(url);
    const messages: any[] = [];
    client.on("message", (data, binary) => { if (!binary) messages.push(JSON.parse(data.toString())); });
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({kind: "vector", request: {pattern: "lattice"}}));
    await closed;
    assert.equal(requests, 1);
    assert.match(messages.find(m => m.event === "error").detail, /before completion.*not replayed/);
  });
});

test("browser disconnect cancels its active exposure service connection", {timeout: 8000}, async () => {
  await sessionFixture(async (url, source) => {
    const connected = once(source, "connection");
    const client = new WebSocket(url);
    await once(client, "open");
    client.send(JSON.stringify({kind: "vector", request: {pattern: "lattice"}}));
    const [socket] = await connected;
    const closed = once(socket, "close");
    client.terminate();
    await closed;
    assert.equal(socket.readyState, WebSocket.CLOSED);
  });
});

test("exposure and View completion is relayed before the upstream socket closes", async () => {
  const upstream = createServer();
  const source = new WebSocketServer({server: upstream});
  source.on("connection", socket => {
    socket.once("message", () => {
      socket.send(Buffer.from([0x12, 0x34]), {binary: true});
      socket.send(JSON.stringify({event: "done", chunks: 1, marker: "upstream-complete"}));
      socket.close(1000);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const old = {target: config.proxyTargetWs, mock: config.mock};
  config.proxyTargetWs = `ws://127.0.0.1:${(upstream.address() as {port: number}).port}`;
  config.mock = false;
  const proxy = createServer();
  attachWsProxy(proxy);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    for (const request of [{pattern: "lattice"}, {resolution: 1, preview: true, exposure_view: true}]) {
      const path = "pattern" in request ? "vector" : "raster";
      const client = new WebSocket(`ws://127.0.0.1:${(proxy.address() as {port: number}).port}/ws/scan/${path}/stream`);
      const messages: Array<{binary: boolean; data: Buffer}> = [];
      client.on("message", (data, binary) => messages.push({binary, data: Buffer.from(data as Buffer)}));
      await once(client, "open");
      const closed = once(client, "close");
      client.send(JSON.stringify(request));
      await closed;
      assert.equal(messages.length, 2);
      assert.equal(messages[0].binary, true);
      assert.deepEqual([...messages[0].data], [0x12, 0x34]);
      assert.equal(messages[1].binary, false);
      assert.equal(JSON.parse(messages[1].data.toString()).marker, "upstream-complete");
    }
  } finally {
    for (const socket of source.clients) socket.terminate();
    config.proxyTargetWs = old.target;
    config.mock = old.mock;
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => source.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
