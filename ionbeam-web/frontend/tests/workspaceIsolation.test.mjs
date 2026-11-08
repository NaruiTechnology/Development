import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("workspace data, delayed events, streams, Stop/Clear and wedge levels are isolated", async () => {
  const keys = ["window", "fetch", "WebSocket", "requestAnimationFrame", "cancelAnimationFrame", "Image"];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const sockets = [];
  const aborts = [];
  let delayedAbort = null;
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(() => fn(performance.now()), 0), cancelAnimationFrame: clearTimeout,
  };
  globalThis.Image = class { set src(_) {} };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/scan/abort")) {
      aborts.push(String(url));
      if (delayedAbort) await delayedAbort;
    }
    return { ok: true, status: 200, json: async () => [], text: async () => "" };
  };
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; requests = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { if (!this.readyState) { this.readyState = 1; void this.onopen?.(); } });
    }
    send(data) { this.requests.push(JSON.parse(data)); }
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code }); });
    }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { WorkspaceProvider, getWorkspaceStore } = await vite.ssrLoadModule("/src/store/index.ts");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const images = await vite.ssrLoadModule("/src/store/imageSlice.ts");
    const patterns = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const { useScanStream } = await vite.ssrLoadModule("/src/hooks/useScanStream.ts");
    const { useLevelSetting } = await vite.ssrLoadModule("/src/hooks/useLevelSetting.ts");
    const { stopScanActions } = await vite.ssrLoadModule("/src/hooks/scanActionRegistry.ts");
    const { SimulationImageCard } = await vite.ssrLoadModule("/src/components/SimulationImageCard.tsx");
    const scanStore = getWorkspaceStore("scan");
    const processingStore = getWorkspaceStore("processing");
    const api = {};
    function Harness({ workspace }) {
      const stream = useScanStream();
      const [levels, setLevels] = useLevelSetting("roi");
      api[workspace] = { stream, levels, setLevels };
      return React.createElement(SimulationImageCard, { disabled: false });
    }
    await act(async () => {
      renderer = create(React.createElement(React.Fragment, null, ...["scan", "processing"].map(workspace =>
        React.createElement(WorkspaceProvider, { key: workspace, workspace }, React.createElement(Harness, { workspace })))));
    });
    assert.notEqual(scanStore.getState().image.frame, processingStore.getState().image.frame);
    assert.notEqual(scanStore.getState().image.vectorImage, processingStore.getState().image.vectorImage);
    const scanDispatch = scanStore.dispatch;
    await act(async () => {
      scanDispatch(scan.updateVector({ dwell: 7, vector_resolution: 8 }));
      processingStore.dispatch(scan.updateVector({ dwell: 31, vector_resolution: 16 }));
      processingStore.dispatch(scan.updateROI({ imageName: "processing.png", imageKind: "file", imageDataUrl: "data:processing" }));
      api.scan.setLevels({ mode: "manual", low: 10, high: 60 });
      api.processing.setLevels({ mode: "manual", low: 150, high: 230 });
      processingStore.dispatch(patterns.setWorkflowProgress([{ id: "process-step", status: "current", threshold: 80 }]));
    });
    assert.equal(scanStore.getState().scan.vector.dwell, 7);
    assert.equal(processingStore.getState().scan.vector.dwell, 31);
    assert.deepEqual(api.scan.levels, { mode: "manual", low: 10, high: 60 });
    assert.deepEqual(api.processing.levels, { mode: "manual", low: 150, high: 230 });
    assert.deepEqual(scanStore.getState().processing.workflowProgress, []);
    const request = { pattern: "default", scan_path: "horizontal_sawtooth", vector_resolution: 8,
      dwell: 0, latency_bytes: 16, output_mode: "SixteenBit", adc_valid: true, cookie: 123, pre_process: false, do_validate: false };
    await act(async () => { api.scan.stream.startVector(request, { edge: 8 }); });
    assert.equal(sockets.length, 1);
    assert.equal(scanStore.getState().scan.phase, "running");
    assert.equal(processingStore.getState().scan.phase, "idle");
    await act(async () => {
      sockets[0].onmessage({ data: Uint8Array.of(0x12, 0x34).buffer });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(scanStore.getState().image.vectorImage[0], 0x1234);
    assert.equal(processingStore.getState().image.vectorImage[0], 0);
    assert.equal(processingStore.getState().scan.bytesReceived, 0);
    await act(async () => { api.processing.stream.startVector(request, { edge: 8 }); });
    assert.equal(sockets.length, 1, "Processing cannot take over SCAN's instrument");
    assert.equal(sockets[0].readyState, Socket.OPEN);
    await act(async () => { stopScanActions("processing"); });
    assert.equal(aborts.length, 0, "Processing Stop cannot send a global abort for SCAN");
    const cards = renderer.root.findAllByType(SimulationImageCard);
    const clearProcessing = cards[1].findAllByType("button").find(button =>
      button.props.children?.some?.(child => child === "Clear image"));
    assert.ok(clearProcessing);
    await act(async () => { clearProcessing.props.onClick(); });
    assert.equal(processingStore.getState().scan.roi.imageDataUrl, null);
    assert.equal(scanStore.getState().scan.phase, "running");
    assert.equal(sockets[0].readyState, Socket.OPEN);
    await act(async () => { scanDispatch(scan.updateVector({ dwell: 3 })); });
    assert.equal(processingStore.getState().scan.vector.dwell, 31, "late SCAN callbacks keep their original dispatch");
    let finishAbort;
    delayedAbort = new Promise(resolve => { finishAbort = resolve; });
    await act(async () => { stopScanActions("scan"); await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(aborts.length, 1);
    assert.equal(sockets[0].readyState, Socket.CLOSED);
    await act(async () => { api.processing.stream.startVector(request, { edge: 8 }); });
    assert.equal(sockets.length, 1, "a delayed SCAN HTTP abort cannot kill a new Processing stream");
    await act(async () => { finishAbort(); await new Promise(resolve => setTimeout(resolve, 20)); });
    delayedAbort = null;
    await act(async () => { api.processing.stream.startVector(request, { edge: 8 }); });
    assert.equal(sockets.length, 2);
    const savedScan = scanStore.getState().image.vectorImage.slice();
    await act(async () => {
      sockets[1].onmessage({ data: Uint8Array.of(0xab, 0xcd).buffer });
      await new Promise(resolve => setTimeout(resolve, 30));
      processingStore.dispatch(images.resetVector());
    });
    assert.deepEqual(scanStore.getState().image.vectorImage, savedScan);
    assert.equal(scanStore.getState().scan.vector.dwell, 3);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
