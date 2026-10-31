import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("live Parallel changes rebuild both scan layouts, preserve pixels, and honor Stop", async () => {
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
    const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, raster: {}, vector: {} } });
    store.dispatch(scan.updateROI({ scan_regions: [
      { x_start: 10, x_end: 30, y_start: 10, y_end: 30 },
      { x_start: 50, x_end: 80, y_start: 50, y_end: 80 },
    ], roi_scan_enabled: true }));
    function Harness({ kind }) {
      const phase = useSelector((state) => state.scan.phase);
      const active = phase === "running" || phase === "stopping";
      return React.createElement(ScanControls, { kind, disabled: active, scanActive: active, zoomDisabled: false });
    }
    const render = (kind) => React.createElement(Provider, { store }, React.createElement(Harness, { kind }));
    const toggle = () => renderer.root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" }).findByType("input");
    // Resolve translated labels from the component's actual i18n source.
    const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
    const buttonByTitle = (key) => renderer.root.findAllByType("button").find((node) => node.props.title === translate("en", key));
    for (const kind of ["raster", "vector"]) {
      store.dispatch(scan.streamReset());
      await act(async () => { renderer = create(render(kind)); });
      const before = sockets.length;
      await act(async () => { await buttonByTitle(kind === "vector" ? "scan.infinite.title.vector" : "scan.infinite.title").props.onClick(); });
      assert.equal(sockets.length, before + 1);
      assert.equal(sockets.at(-1).requests[0].parallel_rois.length, 3);
      assert.equal(toggle().props.disabled, false);
      await act(async () => {
        if (kind === "raster") store.dispatch(image.appendRaster({ pixels: Uint16Array.of(111, 222, 333) }));
        else store.dispatch(image.appendVectorSamples({ values: Uint16Array.of(111, 222, 333) }));
      });
      const pixels = kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage;
      const sampleCopy = pixels.slice();
      await act(async () => { toggle().props.onChange({ target: { checked: false } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      await act(async () => {});
      assert.equal(store.getState().scan.phase, "running");
      assert.equal(toggle().props.checked, false);
      assert.equal(sockets.at(-1).requests[0].parallel_rois ?? null, null);
      assert.equal(kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage, pixels);
      assert.deepEqual(pixels, sampleCopy);
      await act(async () => { toggle().props.onChange({ target: { checked: true } }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      await act(async () => {});
      assert.equal(sockets.at(-1).requests[0].parallel_rois.length, 3);
      assert.equal(toggle().props.disabled, false);
      assert.equal(toggle().props.checked, true);
      // Stop cancels a scheduled handover instead of resurrecting the live scan.
      await act(async () => {
        toggle().props.onChange({ target: { checked: false } });
        buttonByTitle("scan.stop.title").props.onClick();
      });
      const stoppedAt = sockets.length;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      assert.equal(sockets.length, stoppedAt);
      assert.equal(store.getState().scan.phase, "idle");
      await act(async () => { renderer.unmount(); });
      renderer = null;
    }
    // A toggle during async startup must be applied once the stream opens.
    await act(async () => { renderer = create(render("raster")); });
    let allowPrivilege;
    delayPrivilege = new Promise((resolve) => { allowPrivilege = resolve; });
    let starting;
    await act(async () => { starting = buttonByTitle("scan.infinite.title").props.onClick(); });
    await act(async () => { toggle().props.onChange({ target: { checked: false } }); });
    delayPrivilege = null;
    await act(async () => { allowPrivilege(); await starting; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    await act(async () => {});
    assert.equal(sockets.at(-1).requests[0].parallel_rois ?? null, null);
    assert.equal(toggle().props.checked, false);
    await act(async () => { buttonByTitle("scan.stop.title").props.onClick(); });
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
