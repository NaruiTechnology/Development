import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;

async function harness(stairSteps) {
  const old = { window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  globalThis.window = { location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval };
  const aborts = [];
  globalThis.fetch = async url => {
    if (String(url).includes("/api/scan/abort")) { aborts.push(1); return { ok: true, status: 200 }; }
    return { ok: true, status: 200, json: async () => ({ ok: true, registered: true, user: { is_active: true, role: 5 } }) };
  };
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; requests = [];
    constructor(url) { this.url = String(url); sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }); }
    send(data) { this.requests.push(JSON.parse(data)); }
    close(code = 1000) { if (this.readyState >= 2) return; this.readyState = 2; queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code }); }); }
    done() { this.onmessage?.({ data: JSON.stringify({ event: "done" }) }); this.close(); }
    samples(count) { this.onmessage?.({ data: new ArrayBuffer(count * 2) }); }
    get raster() { return this.url.includes("/raster/"); }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  const { store } = await vite.ssrLoadModule("/src/store/index.ts");
  const { ProcessingPatternsPanel } = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
  const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
  store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, exposure_cell_ranges: true, raster: {}, vector: {} } });
  const values = { beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", steps: 3, depth: 3 };
  const parameters = Object.entries(values).map(([name, value]) => ({ name, label: name, type: typeof value === "string" ? "choice" : "float", default: value, min: null, max: null, step: 1, unit: "", choices: typeof value === "string" ? [value] : [] }));
  store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [{ key: "stairs", caption: "Stair cut", model: "StairCutModel", roi: "rect", icon: "patternSolidBox", parameters }], lensLookup }, "t"));
  store.dispatch(processing.setPatternRoi({ key: "stairs", roi: { x_start: 0.1, x_end: 0.9, y_start: 0.1, y_end: 0.9 } }));
  store.dispatch(processing.setPatternEnabled({ key: "stairs", enabled: true }));
  store.dispatch(processing.setStairSteps({ key: "stairs", steps: stairSteps }));
  store.dispatch(scan.updateROI({ x_origin: 0, x_end: 1, y_origin: 0, y_end: 1, scan_zoom: 1 }));
  let renderer;
  await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(ProcessingPatternsPanel, { visible: true, disabled: false }))); });
  const button = label => renderer.root.findAllByType("button").find(b => b.children.some(x => x === label));
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 15)); });
  const until = async (cond, what) => { for (let i = 0; i < 80 && !cond(); i++) await settle(); assert.ok(cond(), what); };
  // Finish whatever stream is open: a raster View needs a full frame of samples.
  const finish = async ws => { await act(async () => { if (ws.raster) ws.samples(ws.requests[0].resolution ** 2); else ws.samples(8); ws.done(); }); await settle(); };
  const close = async () => { renderer.unmount(); await vite.close(); Object.assign(globalThis, old); };
  return { store, sockets, aborts, button, settle, until, finish, close };
}

test("View + pause holds the run after the step, Resume continues, nothing pauses after the last step", async () => {
  const h = await harness([{ after: "viewPause" }, { after: "view" }, { after: "viewPause" }]);
  try {
    const { store, sockets } = h;
    await act(async () => { h.button("Start").props.onClick(); }); await h.settle();
    await h.until(() => sockets.length === 1, "first lattice opens");
    assert.equal(sockets[0].raster, false);
    await h.finish(sockets[0]);
    await h.until(() => sockets.length === 2 && sockets[1].raster, "View runs after step 1");
    await h.finish(sockets[1]);
    await h.until(() => store.getState().exposure.phase === "paused", "run pauses after step 1");
    assert.equal(sockets.length, 2, "no further exposure while paused");
    assert.equal(h.button("Resume") !== undefined, true);
    assert.equal(h.button("Start"), undefined, "Start is replaced by Resume while paused");
    assert.equal(h.button("Stop").props.disabled, false);
    assert.equal(store.getState().exposure.progress[0].status, "completed");
    await act(async () => { h.button("Resume").props.onClick(); }); await h.settle();
    await h.until(() => sockets.length === 3 && !sockets[2].raster, "step 2 starts after Resume");
    await h.finish(sockets[2]);
    await h.until(() => sockets.length === 4 && sockets[3].raster, "step 2 'view' takes a frame");
    await h.finish(sockets[3]);
    await h.until(() => sockets.length === 5 && !sockets[4].raster, "step 2 does not pause");
    assert.notEqual(store.getState().exposure.phase, "paused");
    await h.finish(sockets[4]);
    await h.until(() => sockets.length === 6 && sockets[5].raster, "last step still takes its View");
    await h.finish(sockets[5]);
    await h.until(() => store.getState().exposure.phase === "completed", "no pause after the final step");
    assert.equal(store.getState().exposure.pausedAfterId, null);
  } finally { await h.close(); }
});

test("Stop while paused ends the run as stopped and leaves later steps unexposed", async () => {
  const h = await harness([{ after: "viewPause" }]);
  try {
    const { store, sockets } = h;
    await act(async () => { h.button("Start").props.onClick(); }); await h.settle();
    await h.until(() => sockets.length === 1, "first lattice opens");
    await h.finish(sockets[0]);
    await h.until(() => sockets.length === 2 && sockets[1].raster, "View");
    await h.finish(sockets[1]);
    await h.until(() => store.getState().exposure.phase === "paused", "paused");
    await act(async () => { h.button("Stop").props.onClick(); }); await h.settle();
    await h.until(() => store.getState().exposure.phase === "stopped", "stopped");
    assert.equal(sockets.length, 2, "steps 2 and 3 never start");
    assert.equal(store.getState().exposure.progress.filter(n => n.status === "completed").length, 1);
  } finally { await h.close(); }
});

test("steps without 'after' run straight through", async () => {
  const h = await harness(undefined);
  try {
    const { store, sockets } = h;
    await act(async () => { h.button("Start").props.onClick(); }); await h.settle();
    for (let i = 0; i < 3; i++) { await h.until(() => sockets.length === i + 1, `lattice ${i + 1}`); assert.equal(sockets[i].raster, false); await h.finish(sockets[i]); }
    await h.until(() => store.getState().exposure.phase === "completed", "completed");
    assert.equal(sockets.length, 3);
  } finally { await h.close(); }
});
