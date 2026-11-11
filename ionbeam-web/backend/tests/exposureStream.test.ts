import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {WebSocket, WebSocketServer} from "ws";
import {config} from "../src/config";
import {attachWsProxy} from "../src/wsProxy";

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
