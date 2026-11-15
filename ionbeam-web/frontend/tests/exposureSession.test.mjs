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
    localStorage: {getItem: () => stored, setItem() {}}, setInterval, clearInterval, setTimeout, clearTimeout,
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
    const exposure = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const {worldSelectionToDacROI} = await vite.ssrLoadModule("/src/lib/roiDac.ts");
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
    store.dispatch(scan.updateROI({scan_zoom: 8,
      selection: {x_start: 0.2, x_end: 0.4, y_start: 0.2, y_end: 0.4}}));
    store.dispatch(exposure.setExposureViewZoom(2));
    assert.equal(store.getState().exposure.parallel, false);

    let controls;
    function Harness() { controls = useExposureRun(); return null; }
    await act(async () => { renderer = create(React.createElement(Provider, {store}, React.createElement(Harness))); });
    let completion;
    async function startRun() {
      const count = sockets.length;
      await act(async () => { completion = controls.start(); });
      for (let i = 0; i < 100 && sockets.length === count && !store.getState().exposure.error; i++)
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    await startRun();
    assert.equal(sockets.length, 1, store.getState().exposure.error ?? "exposure opens a session");
    assert.match(sockets[0].url, /\/ws\/exposure\/session/);
    const socket = sockets[0];
    stored = null;
    await act(async () => { await controls.view(); });
    for (let i = 0; i < 100 && socket.requests.at(-1).kind === "vector"; i++)
      await act(async () => socket.done());
    assert.equal(socket.requests.at(-1).kind, "raster");
    const viewRequest = socket.requests.at(-1).request;
    const field = store.getState().scan.roi;
    assert.equal(viewRequest.roi, null);
    assert.deepEqual(viewRequest.parallel_rois, [
      worldSelectionToDacROI({x_start: 0.3, x_end: 0.7, y_start: 0.3, y_end: 0.7}, field),
      worldSelectionToDacROI({x_start: 0.25, x_end: 0.35, y_start: 0.25, y_end: 0.35}, field),
    ], "View uses its own Zoom for every ROI with exposure Parallel off");
    assert.equal(viewRequest.continuous, false);
    assert.equal(store.getState().exposure.viewExpectedSamples, 8);
    await act(async () => { socket.onmessage({data: new ArrayBuffer(8)}); });
    const displayBounds = [
      {x_start: 0.1, x_end: 0.9, y_start: 0.1, y_end: 0.9},
      {x_start: 0.2, x_end: 0.4, y_start: 0.2, y_end: 0.4},
    ];
    assert.deepEqual(store.getState().image.exposureViewFrames.map(frame => frame.bounds), displayBounds,
      "streaming zoomed samples fill the original ROIs rather than shrinking on screen");
    await act(async () => { socket.onmessage({data: new ArrayBuffer(8)}); socket.done(); });
    assert.deepEqual(store.getState().image.exposureViewFrames.map(frame => frame.bounds), displayBounds,
      "completed zoomed frames retain the original display bounds");
    assert.equal(store.getState().exposure.viewPhase, "completed");
    for (let i = 0; i < 100 && store.getState().exposure.phase === "running"; i++)
      await act(async () => socket.done());
    await completion;
    assert.equal(store.getState().exposure.phase, "completed");
    assert.equal(sockets.length, 1);
    assert.equal(authChecks, 1);
    assert.ok(socket.requests.filter(request => request.kind === "vector").length >= 2);

    stored = JSON.stringify({session_token: "new-sign-in"});
    await startRun();
    const failed = sockets.at(-1), requestsBeforeFailure = failed.requests.length;
    await act(async () => failed.onmessage({data: JSON.stringify({event: "error", detail: "USB timeout"})}));
    await completion;
    assert.equal(store.getState().exposure.phase, "error");
    assert.equal(store.getState().exposure.error, "USB timeout");
    assert.equal(failed.requests.length, requestsBeforeFailure);
    assert.equal(sockets.length, 2, "failure never opens a replacement session");
    assert.equal(stored, JSON.stringify({session_token: "new-sign-in"}), "a transport error preserves sign-in");
    await startRun();
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

for (const parallel of [false, true]) {
  for (const hold of [0, 1]) {
    test(`single-pass ROI instances automatically View with hold=${hold}, Parallel=${parallel}`, async () => {
      const previous = {window: globalThis.window, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch};
      const holds = [], sockets = [];
      globalThis.window = {location: {hostname: "example.test", protocol: "http:", host: "example.test"},
        localStorage: {getItem: () => JSON.stringify({session_token: "signed-in"}), setItem() {}},
        setTimeout: (callback, delay) => {
          if (delay === 1000) { holds.push(delay); queueMicrotask(callback); return 0; }
          return setTimeout(callback, delay);
        }, clearTimeout, setInterval, clearInterval, addEventListener() {}, removeEventListener() {}};
      globalThis.fetch = async () => ({ok: true, json: async () => ({ok: true, registered: true, user: {is_active: true, role: 5}})});
      class Socket {
        static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; requests = []; completed = 0;
        constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
        send(raw) { this.requests.push(JSON.parse(raw)); }
        close() { this.readyState = 2; }
        finish() {
          const message = this.requests[this.completed++];
          if (message.kind === "raster") this.onmessage?.({data: new ArrayBuffer(16)});
          this.onmessage?.({data: JSON.stringify({event: "done"})});
        }
      }
      globalThis.WebSocket = Socket;
      const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
        optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
      let renderer;
      try {
        const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
        const store = getWorkspaceStore("processing");
        const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
        const exposure = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
        const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
        const {useExposureRun} = await vite.ssrLoadModule("/src/hooks/useExposureRun.ts");
        const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;
        store.dispatch({type: "status/defaults/fulfilled", payload: {
          is_production: false, exposure_cell_ranges: false, exposure_session_stream: true, raster: {}, vector: {}}});
        const values = {beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", passes: 1};
        store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns: [{key: "box", caption: "Box", model: "SolidBoxModel", roi: "rect",
          parameters: Object.entries(values).map(([name, value]) => ({name, label: name, type: typeof value === "string" ? "choice" : "float",
            default: value, choices: typeof value === "string" ? [value] : []}))}], lensLookup}, "automatic-view"));
        store.dispatch(scan.updateROI({x_origin: 0, x_end: 1, y_origin: 0, y_end: 1}));
        store.dispatch(scan.updateRaster({resolution: 2}));
        for (const x of [0.1, 0.6]) store.dispatch(processing.createPatternRoi({key: "box",
          roi: {x_start: x, x_end: x + 0.2, y_start: 0.1, y_end: 0.3}}));
        store.dispatch(exposure.setExposureParallel(parallel));
        store.dispatch(exposure.setExposureViewPauseSeconds(hold));
        let controls, completion, settled = false;
        function Harness() { controls = useExposureRun(); return null; }
        await act(async () => { renderer = create(React.createElement(Provider, {store}, React.createElement(Harness))); });
        await act(async () => { completion = controls.start().finally(() => { settled = true; }); });
        for (let i = 0; i < 100 && !settled; i++) {
          await act(async () => {
            const socket = sockets[0];
            if (socket && socket.completed < socket.requests.length) socket.finish();
            await new Promise(resolve => setTimeout(resolve, 5));
          });
        }
        assert.equal(settled, true, "exposure finishes without manual View requests");
        await completion;
        assert.equal(store.getState().exposure.phase, "completed", store.getState().exposure.error);
        assert.equal(sockets.length, 1, "all ROIs and Views share the owned session");
        const requests = sockets[0].requests;
        assert.equal(requests.filter(message => message.kind === "vector").length, 2);
        const views = requests.filter(message => message.kind === "raster");
        const expectedViews = hold ? parallel ? 1 : 2 : 0;
        assert.equal(views.length, expectedViews, "positive hold scans after each serial pass or parallel round");
        assert.equal(holds.length, expectedViews, "each automatic View uses the selected hold");
        for (const {request} of views) {
          assert.equal(request.parallel_rois.length, 2, "View always scans both ROI instances in parallel");
          assert.equal(request.continuous, false);
        }
      } finally {
        await act(async () => renderer?.unmount());
        await vite.close();
        Object.assign(globalThis, previous);
      }
    });
  }
}
