import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import React from "react";
import {Provider} from "react-redux";
import {act, create} from "react-test-renderer";
import {createServer} from "vite";

test("exposure hook shares a session across segments, View and passes; failures never restart it", async () => {
  const previous = {window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch};
  let stored = JSON.stringify({session_token: "signed-in"}), authChecks = 0;
  globalThis.window = {location: {hostname: "example.test", protocol: "http:", host: "example.test"},
    localStorage: {getItem: () => stored, setItem() {}}, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {}};
  globalThis.fetch = async url => {
    assert.match(String(url), /current-account/);
    authChecks++;
    return {ok: true, json: async () => ({ok: true, registered: true, user: {is_active: true, role: 5}})};
  };
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; requests = [];
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) { this.requests.push(JSON.parse(raw)); }
    close() { this.readyState = 2; }
    done() { this.onmessage?.({data: JSON.stringify({event: "done"})}); }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer;
  try {
    const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
    const store = getWorkspaceStore("processing");
    const {useExposureRun} = await vite.ssrLoadModule("/src/hooks/useExposureRun.ts");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;
    store.dispatch({type: "status/defaults/fulfilled", payload: {
      is_production: false, exposure_cell_ranges: true, exposure_session_stream: true, raster: {}, vector: {}}});
    const values = {beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", passes: 2};
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns: [{key: "box", caption: "Box",
      model: "SolidBoxModel", roi: "rect", parameters: Object.entries(values).map(([name, value]) => ({
        name, label: name, type: typeof value === "string" ? "choice" : "float", default: value, choices: typeof value === "string" ? [value] : [],
      }))}], lensLookup}, "session"));
    store.dispatch(processing.setPatternRoi({key: "box", roi: {x_start: 0.1, x_end: 0.9, y_start: 0.1, y_end: 0.9}}));
    store.dispatch(scan.updateRaster({resolution: 2}));
    let controls;
    function Harness() { controls = useExposureRun(); return null; }
    await act(async () => { renderer = create(React.createElement(Provider, {store}, React.createElement(Harness))); });
    let completion;
    await act(async () => { completion = controls.start(); });
    assert.equal(sockets.length, 1);
    assert.match(sockets[0].url, /\/ws\/exposure\/session/);
    const socket = sockets[0];
    stored = null;
    await act(async () => { await controls.view(); });
    for (let i = 0; i < 100 && socket.requests.at(-1).kind === "vector"; i++)
      await act(async () => socket.done());
    assert.equal(socket.requests.at(-1).kind, "raster");
    await act(async () => { socket.onmessage({data: new ArrayBuffer(8)}); socket.done(); });
    assert.equal(store.getState().exposure.viewPhase, "completed");
    for (let i = 0; i < 100 && store.getState().exposure.phase === "running"; i++)
      await act(async () => socket.done());
    await completion;
    assert.equal(store.getState().exposure.phase, "completed");
    assert.equal(sockets.length, 1);
    assert.equal(authChecks, 1);
    assert.ok(socket.requests.filter(request => request.kind === "vector").length >= 2);

    stored = JSON.stringify({session_token: "new-sign-in"});
    await act(async () => { completion = controls.start(); });
    const failed = sockets.at(-1), requestsBeforeFailure = failed.requests.length;
    await act(async () => failed.onmessage({data: JSON.stringify({event: "error", detail: "USB timeout"})}));
    await completion;
    assert.equal(store.getState().exposure.phase, "error");
    assert.equal(store.getState().exposure.error, "USB timeout");
    assert.equal(failed.requests.length, requestsBeforeFailure);
    assert.equal(sockets.length, 2, "failure never opens a replacement session");
    assert.equal(stored, JSON.stringify({session_token: "new-sign-in"}), "a transport error preserves sign-in");
    await act(async () => { completion = controls.start(); });
    const stopped = sockets.at(-1);
    await act(async () => { await controls.stop(); });
    await completion;
    assert.equal(store.getState().exposure.phase, "stopped");
    assert.equal(stopped.readyState, 2);
    assert.equal(authChecks, 3, "Stop uses the owned connection without calling global abort");
  } finally {
    await act(async () => renderer?.unmount());
    await vite.close();
    Object.assign(globalThis, previous);
  }
});
