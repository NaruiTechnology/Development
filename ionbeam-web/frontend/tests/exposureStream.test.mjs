import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "vite";

test("exposure transport reuses authorization and settles every terminal path", async t => {
  const previous = {window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch};
  let stored = JSON.stringify({session_token: "original-token"});
  globalThis.window = {location: {hostname: "example.test", protocol: "http:", host: "example.test"},
    localStorage: {getItem: () => stored}};
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; requests = [];
    constructor(url) { this.url = url; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) { this.requests.push(JSON.parse(raw)); }
    message(data) { this.onmessage?.({data: typeof data === "object" && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data}); }
    close(code) {
      assert.ok(code === 1000 || code >= 3000 && code <= 4999, "browser-valid close code");
      this.readyState = 2;
      // No close event: promise settlement must not depend on the handshake.
    }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  try {
    const {ExposureStream, exposureIdleTimeoutMs, exposureJson} = await vite.ssrLoadModule("/src/lib/exposureStream.ts");
    t.mock.timers.enable({apis: ["setTimeout"]});
    const request = {pattern: "lattice", lattice: {dwell: 7}, dwell: 0, latency_bytes: 4096, output_mode: "SixteenBit"};
    const stream = new ExposureStream(true);
    let samples = 0;
    let run = stream.run(request, buffer => { samples += buffer.byteLength / 2; });
    const first = sockets.at(-1);
    first.open(); first.message(new ArrayBuffer(4)); first.message({event: "done"});
    await run;
    assert.equal(samples, 2);
    assert.equal(first.readyState, 1, "done preserves the authenticated connection");
    stored = null; // UI session expiry/localStorage changes must not reauthenticate an active run.
    run = stream.run({...request, exposure_view: true}, () => {});
    assert.equal(sockets.length, 1);
    assert.equal(first.requests[1].kind, "raster");
    first.message({event: "done"}); await run;
    assert.match(first.url, /auth=original-token/);
    stream.close();

    // A slow programmed dwell is allowed; heartbeats cannot conceal a stalled acquisition.
    const slow = {...request, lattice: {dwell: 65535}, latency_bytes: 131072};
    assert.ok(exposureIdleTimeoutMs(slow) > 60_000);
    assert.ok(exposureIdleTimeoutMs(slow, 12) > exposureIdleTimeoutMs(slow), "configured ADC timing affects the deadline");
    const stalled = new ExposureStream(true);
    run = stalled.run(request, () => {});
    const timedOut = assert.rejects(run, /acquisition timed out.*not replayed/);
    const second = sockets.at(-1); second.open();
    for (let i = 0; i < 7; i++) { t.mock.timers.tick(10_000); second.message({event: "heartbeat"}); }
    await timedOut;
    const count = sockets.length;
    await assert.rejects(stalled.run(request, () => {}), /timed out/);
    assert.equal(sockets.length, count, "uncertain dose is never replayed");

    // Each request has its own dwell deadline, including after switching from View.
    const switched = new ExposureStream(true);
    run = switched.run(request, () => {});
    const third = sockets.at(-1); third.open(); third.message({event: "done"}); await run;
    run = switched.run(slow, () => {});
    third.message(new ArrayBuffer(2));
    for (let i = 0; i < 7; i++) { t.mock.timers.tick(10_000); third.message({event: "heartbeat"}); }
    assert.equal(switched.failed, false);
    third.message({event: "done"}); await run; switched.close();

    const broken = new ExposureStream(false);
    run = broken.run(request, () => {});
    const errored = assert.rejects(run, /connection failed/);
    sockets.at(-1).onerror(); await errored;

    const malformed = new ExposureStream(true);
    run = malformed.run(request, () => {});
    const invalid = assert.rejects(run, /Invalid exposure sample/);
    sockets.at(-1).open(); sockets.at(-1).message(new ArrayBuffer(3)); await invalid;

    let awakened = false;
    const paused = new ExposureStream(true, () => { awakened = true; });
    run = paused.run(request, () => {});
    sockets.at(-1).open(); sockets.at(-1).message({event: "done"}); await run;
    t.mock.timers.tick(35_001);
    assert.equal(awakened, true, "an idle/paused session notices lost transport");
    assert.equal(paused.failed, true);

    const stop = new ExposureStream(true);
    run = stop.run(request, () => {});
    const stopped = assert.rejects(run, /stopped/);
    stop.close(); await stopped;
    assert.equal(sockets.at(-1).requests.length, 0, "Stop during connection setup sends no exposure");

    // Abort covers JSON body consumption, not only receipt of HTTP headers.
    const controller = new AbortController();
    globalThis.fetch = async (_url, {signal}) => ({ok: true, json: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    })});
    const http = exposureJson("/account", {signal: controller.signal});
    await Promise.resolve();
    const aborted = assert.rejects(http);
    controller.abort(); await aborted;
  } finally {
    t.mock.timers.reset();
    await vite.close();
    Object.assign(globalThis, previous);
  }
});
