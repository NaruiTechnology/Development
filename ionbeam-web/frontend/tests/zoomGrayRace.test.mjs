import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("a gray-level change and a Zoom change during a sequential Live scan both take effect", async () => {
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
  globalThis.fetch = async (url) => {
    let body = null;
    if (String(url).includes("current-account")) {
      if (delayPrivilege) await delayPrivilege;
      body = { ok: true, registered: true, user: { is_active: true, role: 5 } };
    } else if (String(url).includes("equipment")) body = [];
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
    const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, raster: {}, vector: {} } });
    store.dispatch(scan.updateROI({ scan_regions: [
      { x_start: 10, x_end: 30, y_start: 10, y_end: 30 },
      { x_start: 50, x_end: 80, y_start: 50, y_end: 80 },
    ], roi_scan_enabled: true, scan_zoom: 1 }));
    let setGray;
    function Harness() {
      const phase = useSelector((state) => state.scan.phase);
      const [gray, updateGray] = React.useState(null);
      setGray = updateGray;
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, {
        kind: "vector", disabled: active, scanActive: active, zoomDisabled: false,
        vectorGrayScaleSelection: gray, vectorGrayScaleSkipped: gray ? true : null,
      });
    }
    await act(async () => {
      renderer = create(React.createElement(Provider, { store }, React.createElement(Harness)));
    });
    const root = renderer.root;
    const button = (key) => root.findAllByType("button").find((node) => node.props.title === translate("en", key));
    const zoomInput = () => root.findAll((node) => node.props.ariaLabel === translate("en", "scan.zoom") && node.props.onValueChange)[0];
    const roiWidth = (socket) => { const roi = socket.requests[0]?.roi; return roi ? roi.x_end - roi.x_start : null; };
    // Complete the current pass the way the service does, so the sequence advances.
    const finishPass = async (socket) => {
      await act(async () => {
        await socket.onmessage?.({ data: JSON.stringify({ event: "done", chunks: 0, image_filename: null, csv_filename: null }) });
        socket.close(1000);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    };
    // Sequential mode: Parallel off before Live starts.
    await act(async () => {
      root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" })
        .findByType("input").props.onChange({ target: { checked: false } });
    });
    await act(async () => { await button("scan.infinite.title.vector").props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(store.getState().scan.phase, "running");
    // Pass 1 is the full-frame background; pass 2 is the first ROI, at Zoom 1.
    await finishPass(sockets.at(-1));
    const unzoomedWidth = roiWidth(sockets.at(-1));
    assert.ok(unzoomedWidth > 0, "the first ROI pass is running");
    const startedSockets = sockets.length;

    // The gray-level filter queues a restart (to rebuild the prepared bitmaps)...
    await act(async () => { setGray([100, 200]); });
    // ...and a Zoom edit lands inside its debounce window.
    await act(async () => { await zoomInput().props.onValueChange("2"); });
    assert.equal(store.getState().scan.roi.scan_zoom, 2, "the Zoom value is committed immediately");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    await act(async () => {});
    assert.ok(sockets.length > startedSockets, "the pending gray-level restart must not be cancelled by the Zoom edit");
    assert.equal(store.getState().scan.phase, "running");
    assert.equal(store.getState().scan.roi.scan_zoom, 2);
    await finishPass(sockets.at(-1));
    const zoomedWidth = roiWidth(sockets.at(-1));
    assert.ok(zoomedWidth > 0 && zoomedWidth < unzoomedWidth,
      `the restarted sequence scans the ROI at Zoom 2 (${zoomedWidth} < ${unzoomedWidth})`);
    await act(async () => { button("scan.stop.title").props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
