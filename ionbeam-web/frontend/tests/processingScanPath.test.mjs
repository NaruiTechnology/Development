import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

for (const kind of ["raster", "vector"]) {
  test(`Processing ${kind} scan path draws without a selected ROI and honors its toggle`, async () => {
    const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame"];
    const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
    const callbacks = new Map();
    let nextFrame = 0;
    globalThis.window = {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener() {}, removeEventListener() {},
    };
    globalThis.requestAnimationFrame = (fn) => { callbacks.set(++nextFrame, fn); return nextFrame; };
    globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
    const operations = [];
    const ctx = new Proxy({}, { get: (_, name) => (...args) => operations.push([name, ...args]) });
    const canvas = { width: 640, height: 640, getContext: () => ctx };
    const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
    let renderer;
    try {
      const { store } = await vite.ssrLoadModule("/src/store/index.ts");
      const { ROIEditor } = await vite.ssrLoadModule("/src/components/ROIEditor.tsx");
      const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
      store.dispatch(scan.updateROI({ selection: null, raster_show_scan_path: kind === "raster", vector_show_scan_path: kind === "vector" }));
      store.dispatch(scan.streamStarted());
      await act(async () => {
        renderer = create(React.createElement(Provider, { store }, React.createElement(ROIEditor,
          { disabled: true, variant: "canvas", processingPreview: kind })), {
          createNodeMock: (node) => node.props.className === "roi-canvas-layer roi-canvas-layer--scan-path" ? canvas : null,
        });
      });
      assert.ok(operations.some(([op]) => op === "stroke"), "the active sweep must be visible without a selection");
      assert.ok(operations.some(([op]) => op === "arc"), "the marker remains visible at a live frame boundary (cursor zero)");
      assert.equal(callbacks.size, 1, "one animation loop follows the live scan");
      operations.length = 0;
      await act(async () => {
        store.dispatch(scan.updateROI(kind === "raster" ? { raster_show_scan_path: false } : { vector_show_scan_path: false }));
      });
      assert.equal(callbacks.size, 0, "disabling the overlay cancels animation");
      assert.ok(operations.some(([op]) => op === "clearRect"));
      assert.ok(!operations.some(([op]) => op === "stroke"));
    } finally {
      if (renderer) await act(async () => { renderer.unmount(); });
      await vite.close();
      Object.assign(globalThis, originals);
    }
  });
}
