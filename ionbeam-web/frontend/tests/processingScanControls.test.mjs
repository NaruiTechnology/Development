import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Processing waits for Run, shares its stream and honors Stop", async () => {
  const originals = Object.fromEntries(["window", "fetch", "WebSocket", "requestAnimationFrame", "cancelAnimationFrame"]
    .map((key) => [key, globalThis[key]]));
  const sockets = [];
  let delayPrivilege = null;
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  const abortCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/scan/abort")) abortCalls.push(String(url));
    let body = null;
    if (String(url).endsWith("/api/scan/queues") && init?.method === "POST") {
      body = { id: "test-queue", status: "queued", next_index: 0, total: JSON.parse(init.body).entries.length };
    }
    if (String(url).includes("current-account")) {
      if (delayPrivilege) await delayPrivilege;
      body = { ok: true, registered: true, user: { is_active: true, role: 5 } };
    } else if (String(url).includes("equipment")) body = { ok: true, equipment: [
      { id: 3, name: "DB235", site: "Beijing(北京)", model: "", serial_number: "test", description: "" },
    ] };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    requests = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; void this.onopen?.(); } });
    }
    send(data) { this.requests.push(JSON.parse(data)); }
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code }); });
    }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { ScanControls } = await vite.ssrLoadModule("/src/components/ScanControls.tsx");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [
      { key: "ring", model: "RingModel", caption: "Ring", icon: "ring", roi: "ring", parameters: [] },
    ] }, "test"));
    store.dispatch(processing.setPatternEnabled({ key: "ring", enabled: true }));
    store.dispatch(processing.setPatternRoi({ key: "ring", roi: { cx: 50, cy: 50, r_outer: 20, r_inner: 10 } }));
    const { VectorScanExecutionSettings } = await vite.ssrLoadModule("/src/components/VectorScanExecutionSettings.tsx");
    const { PresetNumberField } = await vite.ssrLoadModule("/src/components/PresetNumberField.tsx");
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, raster: {}, vector: {} } });
    store.dispatch(scan.setKind("roi"));
    function Harness({ ready, request, processing = true, blocked = false }) {
      const phase = useSelector((state) => state.scan.phase);
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, { kind: "vector", disabled: active || blocked,
        scanActive: active, processingMode: processing,
        firstRowContent: React.createElement(VectorScanExecutionSettings, { disabled: active || blocked, showScanPath: !processing }) });
    }
    const render = (ready, request, processing = true, blocked = false) => React.createElement(Provider, { store },
      React.createElement(Harness, { ready, request, processing, blocked }));
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    await act(async () => { renderer = create(render(false, 1)); });
    assert.equal(sockets.length, 0, "no acquisition before the configured image is ready");
    const pathField = renderer.root.findByProps({ id: "vector-scan-path", className: "select" });
    const fields = renderer.root.findAllByType(PresetNumberField);
    assert.equal(fields.length, 2, "Processing shares resolution and dwell fields");
    assert.equal(renderer.root.findAllByProps({ className: "scan-equipment-field" }).length, 2);
    const selectors = renderer.root.findAllByProps({ className: "scan-equipment-field" });
    assert.equal(selectors[0].findByType("select").props.value, "Beijing(北京)");
    assert.equal(selectors[1].findByType("select").props.value, "3");
    const zoom = renderer.root.findByProps({ className: "scan-equipment-field scan-zoom-field" });
    assert.ok(zoom, "Processing exposes the shared Zoom control");
    await act(async () => {
      pathField.props.onChange({ target: { value: "vertical_raster" } });
      fields[0].props.onChange(128);
      fields[1].props.onChange(3);
    });
    assert.equal(store.getState().scan.vector.scan_path, "vertical_raster");
    assert.equal(store.getState().scan.vector.vector_resolution, 128);
    assert.equal(store.getState().scan.vector.dwell, 3);

    await act(async () => { renderer.update(render(true, 1, true, true)); });
    await settle();
    assert.equal(sockets.length, 0, "a pending start waits for existing scan safety guards");
    // Leaving before the deferred callback runs must not consume the request.
    act(() => { renderer.update(render(true, 1)); });
    act(() => { renderer.update(render(true, 1, false)); });
    await settle();
    assert.equal(sockets.length, 0, "cleanup cancels the pending auto-start callback");
    await act(async () => { renderer.update(render(true, 1)); });
    await settle();
    assert.equal(sockets.length, 0, "image readiness and entering Processing must not start acquisition");
    const clickRun = async () => {
      const run = renderer.root.findAllByType("button").find((node) => node.props["aria-pressed"] !== undefined);
      assert.ok(run, "Processing exposes Run");
      await act(async () => { await run.props.onClick(); });
      await settle();
    };
    await clickRun();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].requests[0].continuous, true);
    assert.equal(sockets[0].requests[0].scan_path, "vertical_raster");
    assert.equal(sockets[0].requests[0].vector_resolution, 128);
    assert.equal(sockets[0].requests[0].dwell, 3);
    const primary = renderer.root.findByProps({ className: "scan-primary-controls" });
    const labels = primary.findAllByType("button").map((node) => node.children.filter((c) => typeof c === "string").join(""));
    assert.deepEqual(labels, ["Scan", "Stop", "Run"]);
    await act(async () => { renderer.update(render(true, 2)); });
    assert.equal(sockets.length, 1, "entering again while live must not duplicate a stream");
    await act(async () => { renderer.update(render(true, 2, false)); });
    assert.equal(sockets[0].readyState, 1, "switching the controller layout keeps the stream open");
    await act(async () => { renderer.update(render(true, 2)); });
    const stop = renderer.root.findAllByType("button").find((node) => node.props.className === "btn btn--stop");
    await act(async () => { stop.props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(sockets.length, 1, "Stop must not retrigger the consumed auto-start request");
    assert.notEqual(store.getState().scan.phase, "running");
    await act(async () => { renderer.update(render(true, 3)); });
    await settle();
    assert.equal(sockets.length, 1, "returning to Processing must not restart acquisition");
    await clickRun();
    assert.equal(sockets.length, 2, "only clicking Run restarts acquisition");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
