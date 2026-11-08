import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Processing drawn patterns drive live ROI windows, Zoom and Parallel without changing Scan ROIs", async () => {
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
    const { VectorScanExecutionSettings } = await vite.ssrLoadModule("/src/components/VectorScanExecutionSettings.tsx");
    const { PresetNumberField } = await vite.ssrLoadModule("/src/components/PresetNumberField.tsx");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, raster: {}, vector: {} } });
    const catalogue = ["solidBox", "openBox"].map((key) => ({ key, caption: key, icon: "patternSolidBox",
      model: "SolidBoxModel", roi: "rect", parameters: [] }));
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: catalogue }, "test"));
    const scanPlan = [{ x_start: 70, x_end: 95, y_start: 70, y_end: 95 },
      { x_start: 5, x_end: 15, y_start: 60, y_end: 80 }];
    store.dispatch(scan.updateROI({ scan_regions: scanPlan, roi_scan_enabled: true, selection: null }));
    function Harness() {
      const phase = useSelector((state) => state.scan.phase);
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, { kind: "vector", disabled: active,
        scanActive: active, processingMode: true });
    }
    const tick = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
    await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(Harness))); });
    const roiToggle = () => renderer.root.findByProps({ className: "processing-parallel-controls" }).findAllByType("input")[0];
    await act(async () => { roiToggle().props.onChange({ target: { checked: false } }); });
    const run = renderer.root.findAllByType("button").find(node => node.props["aria-pressed"] !== undefined);
    await act(async () => { await run.props.onClick(); });
    await tick();
    assert.equal(sockets.at(-1).requests[0].roi, null, "ROI Scan off starts full-field acquisition");
    await act(async () => { store.dispatch(processing.setPatternRoi({ key: "solidBox",
      roi: { x_start: 10, x_end: 30, y_start: 10, y_end: 30 } })); });
    await act(async () => { roiToggle().props.onChange({ target: { checked: true } }); });
    await tick(450);
    let live = sockets.at(-1);
    const roi = live.requests[0].roi;
    assert.ok(roi && roi.x_start > 0 && roi.x_end < 16383, "drawing a pattern switches the live scan to its ROI");
    await act(async () => { live.onmessage({ data: new ArrayBuffer(2) }); });
    const zoom = renderer.root.findByProps({ className: "scan-equipment-field scan-zoom-field" });
    const { NumberStepperInput } = await vite.ssrLoadModule("/src/components/NumberStepperField.tsx");
    await act(async () => { await zoom.findByType(NumberStepperInput).props.onValueChange("2"); });
    const update = live.requests.findLast((request) => request.event === "update_geometry");
    assert.ok(update);
    assert.equal(update.diagnostics.regionCount, 1, "logs count Processing regions, not Scan's saved plan");
    assert.ok(update.geometry.roi.x_end - update.geometry.roi.x_start < roi.x_end - roi.x_start,
      "Zoom narrows the pattern ROI, not the full field");
    await act(async () => { live.onmessage({ data: JSON.stringify({ event: "geometry_updated", id: update.id }) }); });
    await act(async () => { store.dispatch(processing.setPatternRoi({ key: "openBox",
      roi: { x_start: 50, x_end: 80, y_start: 50, y_end: 80 } })); });
    await tick(450);
    const parallel = () => renderer.root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" }).findByType("input");
    assert.equal(sockets.at(-1).requests[0].parallel_rois ?? null, null);
    assert.equal(parallel().props.checked, false, "drawing a second ROI keeps sequential mode");
    await act(async () => { parallel().props.onChange({ target: { checked: true } }); });
    await tick(450);
    assert.equal(sockets.at(-1).requests[0].parallel_rois.length, 2);
    assert.equal(parallel().props.disabled, false, "Parallel remains editable while live");
    await act(async () => { parallel().props.onChange({ target: { checked: false } }); });
    await tick(450);
    assert.equal(sockets.at(-1).requests[0].parallel_rois ?? null, null);
    assert.ok(sockets.at(-1).requests[0].roi, "Parallel off returns to sequential pattern windows");
    await act(async () => {
      roiToggle().props.onChange({ target: { checked: false } });
      store.dispatch(processing.clearPatternRoi("solidBox"));
      store.dispatch(processing.clearPatternRoi("openBox"));
    });
    await tick(450);
    assert.deepEqual(sockets.at(-1).requests[0].roi,
      { x_start: 4096, x_end: 12287, y_start: 4096, y_end: 12287 },
      "clearing patterns restores the full-field plan while retaining the selected Zoom 2");
    assert.equal(roiToggle().props.checked, false);
    assert.deepEqual(store.getState().scan.roi.scan_regions, scanPlan, "Processing must not overwrite Scan's ROI plan");
    assert.equal(store.getState().scan.roi.roi_scan_enabled, true);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
