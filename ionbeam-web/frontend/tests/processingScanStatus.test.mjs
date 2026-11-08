import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { create, act } from "react-test-renderer";
import { createServer } from "vite";

test("Processing status reports raster and custom progress, parallel regions and errors", async () => {
  const original = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} },
    location: { hostname: "example.test", protocol: "http:", host: "example.test" } };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { ProcessingScanStatus } = await vite.ssrLoadModule("/src/components/ProcessingScanStatus.tsx");
    const initial = store.getState();
    const render = async (kind, image, scan = {}) => {
      const state = { ...initial, scan: { ...initial.scan, ...scan, roi: { ...initial.scan.roi,
        x_origin: 0, x_end: 100, y_origin: 0, y_end: 200, scale_unit: "nm", scanGeometry: null } },
        image: { ...initial.image, ...image } };
      const testStore = configureStore({ reducer: () => state, middleware: () => [] });
      await act(async () => {
        renderer?.unmount();
        renderer = create(React.createElement(Provider, { store: testStore },
          React.createElement(ProcessingScanStatus, { kind })));
      });
      const flatten = node => typeof node === "string" ? node : (node?.children ?? []).map(flatten).join("");
      return flatten(renderer.toJSON());
    };
    let text = await render("raster", { resolution: 10, cursor: 50 },
      { phase: "running", chunksReceived: 3, bytesReceived: 100 });
    assert.match(text, /phase running/);
    assert.match(text, /chunks 3/);
    assert.match(text, /bytes 100/);
    assert.match(text, /pixels 50 \/ 100/);
    assert.match(text, /progress 50%/);
    assert.match(text, /\(0.00, 0.00\) nm → \(100.00, 200.00\) nm/);
    text = await render("vector", { vectorPattern: "custom", vectorCustomCount: 40,
      vectorCursor: 10, vectorSource: "vector" }, { errorMessage: "Stream disconnected" });
    assert.match(text, /samples 10 \/ 40/);
    assert.match(text, /progress 25%/);
    assert.equal(renderer.root.findByProps({ role: "alert" }).children[0], "Stream disconnected");
    text = await render("raster", { resolution: 10, cursor: 100,
      rasterParallelROIs: [{ x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 },
        { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 }] });
    assert.match(text, /pixels 100 \/ 200/);
    assert.match(text, /ROI 1/);
    assert.match(text, /ROI 2/);
    text = await render("vector", { vectorSource: "beam_hold", vectorCursor: 100 });
    assert.match(text, /samples 0 \/ 0/);
  } finally {
    await act(async () => renderer?.unmount());
    await vite.close();
    globalThis.window = original;
  }
});
