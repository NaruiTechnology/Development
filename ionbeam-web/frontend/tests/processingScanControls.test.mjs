import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const assetUploads = new Map();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/scan/abort")) abortCalls.push(String(url));
    let body = null;
    if (String(url).endsWith("/api/scan/queues") && init?.method === "POST") {
      body = { id: "test-queue", status: "queued", next_index: 0, total: JSON.parse(init.body).entries.length };
    }
    const asset = String(url).match(/\/api\/scan\/assets\/([^/]+)\/(chunk|complete)/);
    if (String(url).endsWith("/api/scan/assets/prepare")) {
      const upload = JSON.parse(init.body);
      const cached = assetUploads.get(upload.asset_id)?.bitmap !== undefined;
      if (!cached) assetUploads.set(upload.asset_id, {chunks: []});
      body = { asset_id: upload.asset_id, cached, offset: 0 };
    } else if (asset) {
      const upload = assetUploads.get(asset[1]);
      if (asset[2] === "chunk") {
        upload.chunks.push(Buffer.from(init.body));
        body = {asset_id: asset[1], offset: upload.chunks.reduce((total, chunk) => total + chunk.length, 0)};
      } else {
        upload.bitmap = JSON.parse(Buffer.concat(upload.chunks).toString());
        body = {asset_id: asset[1]};
      }
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
    const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [
      { key: "ring", model: "RingModel", caption: "Ring", icon: "ring", roi: "ring", parameters: [] },
    ] }, "test"));
    store.dispatch(processing.setPatternEnabled({ key: "ring", enabled: true }));
    store.dispatch(processing.setPatternRoi({ key: "ring", roi: { cx: 50, cy: 50, r_outer: 20, r_inner: 10 } }));
    const { VectorScanExecutionSettings } = await vite.ssrLoadModule("/src/components/VectorScanExecutionSettings.tsx");
    const { PresetNumberField } = await vite.ssrLoadModule("/src/components/PresetNumberField.tsx");
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, raster: {}, vector: {} } });
    store.dispatch(scan.setKind("roi"));
    function Harness({ ready, request, processing = true, blocked = false, scanKind = "vector" }) {
      const phase = useSelector((state) => state.scan.phase);
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, { kind: scanKind, disabled: active || blocked,
        scanActive: active, processingMode: processing,
        firstRowContent: React.createElement(VectorScanExecutionSettings, { disabled: active || blocked, showScanPath: !processing }) });
    }
    const render = (ready, request, processing = true, blocked = false, scanKind = "vector") => React.createElement(Provider, { store },
      React.createElement(Harness, { ready, request, processing, blocked, scanKind }));
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
      assert.equal(run.props.disabled, false, "Run is enabled when a canvas image is available");
      await act(async () => { await run.props.onClick(); });
      await settle();
    };
    const emptyRun = renderer.root.findAllByType("button").find(node => node.props["aria-pressed"] !== undefined);
    assert.equal(emptyRun.props.disabled, true, "Processing Run requires an image on the canvas");
    assert.equal(renderer.root.findByProps({ className: "scan-primary-controls" })
      .findAllByType("button")[0].props.disabled, false, "Scan remains available to acquire an image");
    await act(async () => { await emptyRun.props.onClick(); });
    assert.equal(sockets.length, 0, "the Run handler also rejects an empty canvas");
    await act(async () => { store.dispatch(image.setupVector({ pattern: "default", edge: 128,
      initialImage: new Uint16Array(128 * 128) })); });
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
    // Pilot workflow: source pixels are frozen, and stream completion advances steps.
    await act(async () => { renderer.root.findAllByType("button").find(n => n.props.className === "btn btn--stop").props.onClick(); });
    await settle();
    const config = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url)));
    const workflows = [config.Workflows.find(w => w.name === "EvenLinelCut")];
    await act(async () => {
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: store.getState().processing.specs,
        workflows, materials: config.Materials }, "pilot"));
      store.dispatch(processing.setPatternWorkflow({ key: "ring", workflow: "EvenLinelCut" }));
      store.dispatch(image.setupVector({ pattern: "default", edge: 128,
        initialImage: Uint16Array.from({length: 128 * 128}, (_, i) => (i % 128 < 64 ? 40 : 200) << 8) }));
    });
    await clickRun();
    assert.equal(sockets.length, 3);
    // Even range-filters Spot: dark = [spectrum min, ROI average]; simulation mills it a finite number of passes.
    const darkAvg = store.getState().processing.workflowProgress[0].threshold;
    assert.equal(sockets[2].requests[0].continuous, true);
    assert.ok(Number.isFinite(sockets[2].requests[0].frames), "cut workflows repeat a finite number of passes");
    assert.equal(sockets[2].requests[0].pattern, "custom");
    assert.equal(sockets[2].requests[0].feedback_mode, "standard");
    assert.deepEqual(sockets[2].requests[0].gray_level_range, [40, darkAvg]);
    assert.equal(sockets[2].requests[0].gray_level_skipped, false);
    assert.equal(sockets[2].requests[0].target_gray_level, darkAvg);
    const uploadedBitmap = assetUploads.get(sockets[2].requests[0].simulation_bitmap_id)?.bitmap;
    assert.ok(uploadedBitmap, "workflow attaches the frozen ROI image instead of falling back to fake ADC data");
    assert.deepEqual(sockets[2].requests[0].roi, uploadedBitmap.source_roi, "ROI spans the actual sampled crop so custom ADC values use the same DAC coordinates");
    assert.ok(uploadedBitmap.pixels.every(pixel => {
      const value = typeof pixel === "number" ? pixel : pixel.value;
      return value === 40 || value === 200;
    }));
    assert.ok(uploadedBitmap.pixels.length < 128 * 128, "upload only the sampled ROI crop");
    assert.equal(store.getState().image.vectorCustomRenderInFrame, true);
    assert.equal(store.getState().image.vectorEdge, 128, "crop dimensions must not change full-frame display size");
    assert.deepEqual(store.getState().processing.workflowProgress.map(p => p.status), ["current", "upcoming"]);
    const darkStarted = store.getState().processing.workflowProgress[0].startedAt;
    assert.equal(typeof darkStarted, "number");
    assert.equal(store.getState().processing.workflowProgress[1].startedAt, undefined);
    assert.ok(sockets[2].requests[0].points.some(p => p[3]));
    assert.ok(sockets[2].requests[0].points.some(p => !p[3]));
    const pointSamples = new Uint8Array(sockets[2].requests[0].points.length * 2);
    sockets[2].requests[0].points.forEach((point, index) => {
      const sample = point[3] ? 0x1234 : darkAvg << 8;
      pointSamples[index * 2] = sample >>> 8;
      pointSamples[index * 2 + 1] = sample & 255;
    });
    await act(async () => { sockets[2].onmessage({data: pointSamples.buffer}); });
    await settle();
    const darkResult = store.getState().image.vectorImage.slice();
    assert.ok(darkResult.some(sample => sample === darkAvg << 8), "Spot feedback changes selected dark pixels");
    assert.ok(darkResult.some(sample => sample === 200 << 8), "unselected bright pixels keep their gray level");
    await act(async () => {
      sockets[2].onmessage({data: JSON.stringify({event: "done", chunks: 1})});
      sockets[2].close();
    });
    await settle();
    assert.equal(sockets.length, 4, "only completion advances to bright step");
    assert.deepEqual(store.getState().image.vectorImage, darkResult, "starting bright preserves the dark action result");
    assert.equal(sockets[3].requests[0].continuous, true);
    assert.equal(sockets[3].requests[0].feedback_mode, "standard");
    assert.deepEqual(sockets[3].requests[0].gray_level_range, [darkAvg, 200]);
    assert.equal(sockets[3].requests[0].gray_level_skipped, false);
    assert.equal(sockets[3].requests[0].target_gray_level, darkAvg);
    assert.equal(store.getState().processing.workflowProgress[1].threshold, darkAvg, "both steps split at the ROI average");
    const brightSamples = new Uint8Array(sockets[3].requests[0].points.length * 2);
    sockets[3].requests[0].points.forEach((point, index) => {
      const value = point[3] ? 0x1234 : darkAvg << 8;
      brightSamples[index * 2] = value >>> 8;
      brightSamples[index * 2 + 1] = value & 255;
    });
    await act(async () => { sockets[3].onmessage({data: brightSamples.buffer}); });
    await settle();
    const equalized = store.getState().image;
    for (let i = 0; i < equalized.vectorCustomCount; i++) {
      const x = equalized.vectorCustomRenderPoints[2 * i];
      const y = equalized.vectorCustomRenderPoints[2 * i + 1];
      assert.equal(equalized.vectorImage[y * 128 + x], darkAvg << 8,
        "every sampled ROI pixel ends at the same frozen average");
    }
    const [darkDone, brightStarted] = store.getState().processing.workflowProgress;
    assert.ok(darkDone.finishedAt >= darkStarted);
    assert.ok(brightStarted.startedAt >= darkDone.finishedAt);
    assert.deepEqual(store.getState().processing.workflowProgress.map(p => p.status), ["completed", "current"]);
    assert.equal(store.getState().processing.instances.ring.workflowEnabled, true,
      "Use workflow remains enabled when a step is in progress");
    await act(async () => { renderer.root.findAllByType("button").find(n => n.props.className === "btn btn--stop").props.onClick(); });
    await settle();
    assert.equal(sockets.length, 4, "Stop does not advance or repeat the cut");
    const stoppedSteps = store.getState().processing.workflowProgress;
    assert.equal(stoppedSteps[0].finishedAt, darkDone.finishedAt);
    assert.ok(stoppedSteps[1].finishedAt >= brightStarted.startedAt);
    assert.deepEqual(stoppedSteps.map(p => p.status), ["completed", "stopped"]);
    assert.equal(store.getState().processing.instances.ring.workflowEnabled, true,
      "an interrupted workflow remains enabled");
    // Toggle retains the selected workflow but restores an ordinary continuous scan.
    await act(async () => { store.dispatch(processing.setPatternWorkflow({key: "ring", enabled: false})); });
    assert.equal(renderer.root.findAllByType("button").find(node => node.props["aria-pressed"] !== undefined)
      .props.disabled, true, "Run disables again when stopping a single workflow clears the canvas");
    await act(async () => { store.dispatch(image.setupVector({ pattern: "default", edge: 128,
      initialImage: new Uint16Array(128 * 128) })); });
    await clickRun();
    assert.equal(sockets.length, 5);
    assert.equal(sockets[4].requests[0].pattern, "default");
    assert.equal(sockets[4].requests[0].continuous, true);
    assert.equal(store.getState().processing.instances.ring.workflow, "EvenLinelCut");
    const roiToggle = () => renderer.root.findByProps({ className: "processing-parallel-controls" })
      .findAllByType("input")[0];
    const parallelToggle = () => renderer.root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" })
      .findByType("input");
    assert.equal(roiToggle().props.checked, true, "ROI scan remains enabled");
    assert.equal(roiToggle().props.disabled, false, "ROI Scan stays editable during Run");
    assert.ok(sockets.at(-1).requests[0].roi, "ROI Run uses the pattern bounds");
    const switchROI = async checked => {
      const previous = sockets.at(-1);
      await act(async () => { roiToggle().props.onChange({ target: { checked } }); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
      await settle();
      assert.equal(previous.readyState, Socket.CLOSED, "old stream closes before replacement");
      assert.notEqual(sockets.at(-1), previous);
      assert.equal(store.getState().scan.infiniteActive, true, "Run continues after mode switch, including sequential passes");
      assert.equal(store.getState().scan.phase, "running");
      assert.equal(store.getState().scan.streamRestarting, false);
      assert.equal(roiToggle().props.checked, checked);
    };
    await switchROI(false);
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null, "OFF scans the full field");
    assert.equal(store.getState().image.vectorROI, null, "display mapping follows the full-field request");
    await act(async () => { sockets.at(-1).onmessage({ data: Uint8Array.of(0x12, 0x34).buffer }); });
    await settle();
    assert.equal(store.getState().image.vectorImage[0], 0x1234, "full-field samples paint outside the drawn ring");
    assert.deepEqual(store.getState().processing.workflowProgress, [], "full-field scan has no ROI workflow steps");
    // Drawing another enabled pattern must not silently select Parallel.
    await act(async () => {
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [
        ...store.getState().processing.specs,
        { key: "free", model: "FreeHandModel", caption: "Free", icon: "free", roi: "polygon", parameters: [] },
      ] }, "second"));
      store.dispatch(processing.setPatternEnabled({ key: "free", enabled: true }));
      store.dispatch(processing.setPatternRoi({ key: "free", roi: { points: [[5, 5], [15, 5], [10, 15]] } }));
    });
    assert.equal(parallelToggle().props.checked, false);
    await switchROI(true);
    assert.equal(parallelToggle().props.disabled, false);
    assert.equal(parallelToggle().props.checked, false, "multiple ROIs start sequentially by default");
    assert.ok(sockets.at(-1).requests[0].roi);
    assert.equal(sockets.at(-1).requests[0].parallel_rois ?? null, null);
    await switchROI(false);
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null);
    await act(async () => { renderer.root.findAllByType("button").find(n => n.props.className === "btn btn--stop").props.onClick(); });
    await settle();
    const stoppedCount = sockets.length;
    await settle();
    assert.equal(sockets.length, stoppedCount, "Stop prevents any further restart");
    await act(async () => { renderer.update(render(true, 4, true, false, "raster")); });
    await clickRun();
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null, "raster starts full-field with ROI Scan off");
    await switchROI(true);
    assert.ok(sockets.at(-1).requests[0].roi, "raster switches to sequential pattern ROIs during Run");
    assert.equal(parallelToggle().props.checked, false);
    await switchROI(false);
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null, "raster returns to full-field during Run");
    assert.equal(store.getState().image.rasterROI, null);
    await act(async () => { sockets.at(-1).onmessage({ data: Uint8Array.of(0x23, 0x45).buffer }); });
    await settle();
    assert.equal(store.getState().image.frame[0], 0x2345, "raster full-field samples paint outside the patterns");

    // Finishing every workflow step returns to an unzoomed full-field live scan.
    await act(async () => { renderer.root.findAllByType("button").find(n => n.props.className === "btn btn--stop").props.onClick(); });
    await settle();
    await act(async () => {
      renderer.update(render(true, 5, true, false, "vector"));
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: store.getState().processing.specs,
        workflows, materials: config.Materials }, "completion"));
      store.dispatch(processing.setPatternEnabled({ key: "free", enabled: false }));
      store.dispatch(processing.setPatternWorkflow({ key: "ring", enabled: true }));
      store.dispatch(scan.setScanZoom(2));
      store.dispatch(image.setupVector({ pattern: "default", edge: 128,
        initialImage: Uint16Array.from({length: 128 * 128}, (_, i) => (i % 128 < 64 ? 40 : 200) << 8) }));
    });
    await act(async () => { roiToggle().props.onChange({ target: { checked: true } }); });
    await clickRun();
    for (let step = 0; step < 2; step++) {
      const current = sockets.at(-1);
      assert.equal(roiToggle().props.checked, true);
      await act(async () => {
        current.onmessage({ data: JSON.stringify({ event: "done", chunks: 1 }) });
        current.close();
      });
      await settle();
    }
    assert.deepEqual(store.getState().processing.workflowProgress.map(p => p.status), ["completed", "completed"]);
    assert.equal(roiToggle().props.checked, false);
    assert.equal(store.getState().scan.roi.scan_zoom, 1);
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null);
    assert.equal(sockets.at(-1).requests[0].pattern, "default");
    assert.equal(sockets.at(-1).requests[0].continuous, true);
    assert.equal(store.getState().scan.phase, "running");
    assert.equal(store.getState().scan.infiniteActive, true);
    await act(async () => { renderer.root.findAllByType("button").find(n => n.props.className === "btn btn--stop").props.onClick(); });
    await settle();
    await act(async () => {
      store.dispatch(processing.clearPatternRoi("ring"));
      roiToggle().props.onChange({ target: { checked: true } });
    });
    const scanButton = renderer.root.findByProps({ className: "scan-primary-controls" })
      .findAllByType("button")[0];
    assert.equal(scanButton.props.disabled, false, "Processing allows Scan before an ROI is drawn");
    const beforeFullField = sockets.length;
    await act(async () => { await scanButton.props.onClick(); });
    await settle();
    assert.equal(sockets.length, beforeFullField + 1, "Scan starts acquisition without a pattern ROI");
    assert.equal(sockets.at(-1).requests[0].roi ?? null, null, "no pattern ROI scans the full field");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
