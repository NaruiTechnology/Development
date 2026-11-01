import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("a burst of Zoom edits with the gray filter on rebuilds sequential ROIs once, one at a time", async () => {
  const originals = Object.fromEntries(["window", "document", "Image", "fetch", "WebSocket", "requestAnimationFrame", "cancelAnimationFrame"]
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
  let prepareCalls = 0;
  globalThis.Image = class { set src(_) { this.naturalWidth = 64; this.naturalHeight = 64; queueMicrotask(() => this.onload?.()); } };
  globalThis.document = { createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
      putImageData() {}, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    }),
  }) };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/scan/assets/prepare")) {
      prepareCalls++;
      return { ok: true, status: 200, json: async () => ({ asset_id: "x", cached: true }), text: async () => "" };
    }
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
    store.dispatch(scan.updateROI({
      imageName: "sim.png", imageKind: "file", imageDataUrl: "data:image/png;base64,AAAA",
      scan_regions: [
        { x_start: 10, x_end: 30, y_start: 10, y_end: 30 },
        { x_start: 50, x_end: 80, y_start: 50, y_end: 80 },
      ], roi_scan_enabled: true, scan_zoom: 1,
    }));
    function Harness() {
      const phase = useSelector((state) => state.scan.phase);
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, {
        kind: "vector", disabled: active, scanActive: active, zoomDisabled: false,
        vectorGrayScaleSelection: [100, 200], vectorGrayScaleSkipped: true,
      });
    }
    await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(Harness))); });
    const root = renderer.root;
    const button = (key) => root.findAllByType("button").find((node) => node.props.title === translate("en", key));
    const zoomInput = () => root.findAll((node) => node.props.ariaLabel === translate("en", "scan.zoom") && node.props.onValueChange)[0];
    await act(async () => {
      root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" })
        .findByType("input").props.onChange({ target: { checked: false } });
    });
    await act(async () => { await button("scan.infinite.title.vector").props.onClick(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(store.getState().scan.phase, "running");
    const baseline = prepareCalls;
    // Four quick Zoom edits (a stepper held down) must not start four rebuilds.
    await act(async () => { for (const value of ["2", "3", "4", "5"]) await zoomInput().props.onValueChange(value); });
    assert.equal(store.getState().scan.roi.scan_zoom, 5, "every edit is committed immediately");
    assert.equal(prepareCalls, baseline, "no bitmap work happens while the edits are still coming");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    await act(async () => {});
    // One rebuild for the settled zoom: one asset per ROI, not four per ROI.
    assert.ok(prepareCalls - baseline > 0 && prepareCalls - baseline <= 2,
      `one rebuild per ROI after the burst settles (got ${prepareCalls - baseline})`);
    assert.equal(store.getState().scan.roi.scan_zoom, 5);
    assert.equal(store.getState().scan.phase, "running");
    // Stop cancels a rebuild that has not started yet.
    await act(async () => { await zoomInput().props.onValueChange("6"); });
    await act(async () => { button("scan.stop.title").props.onClick(); });
    const afterStop = prepareCalls;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    assert.equal(prepareCalls, afterStop, "Stop cancels the pending rebuild");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
