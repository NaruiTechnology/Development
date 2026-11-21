import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { handleExposureSession } from "../src/exposureSession";

test("exposure heartbeat tolerates a delayed pong but terminates an unresponsive client", (t) => {
  let now = 0;
  let tick: () => void = () => {};
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => {
    tick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  const client = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    pings: 0,
    terminations: 0,
    send() {},
    ping() { this.pings++; },
    terminate() { this.terminations++; },
  });
  handleExposureSession(client as unknown as WebSocket);
  now = 10_000; tick();
  now = 20_000; tick();
  now = 30_000; tick();
  assert.equal(client.terminations, 0, "one delayed pong must not abort the exposure");
  assert.equal(client.pings, 3);
  client.emit("pong");
  now = 40_000; tick();
  now = 60_000; tick();
  assert.equal(client.terminations, 0, "the delayed pong renews the liveness window");
  now = 70_000; tick();
  assert.equal(client.terminations, 1, "a dead client is still terminated");
  client.emit("close", 1006, Buffer.alloc(0));
});
