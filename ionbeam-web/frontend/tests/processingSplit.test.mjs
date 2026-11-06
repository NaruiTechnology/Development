import test from "node:test";
import assert from "node:assert/strict";
import React, { useEffect } from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Processing Split freezes snapshots, retains live canvas, and shares pane advancement/lock", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} },
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    addEventListener() {}, removeEventListener() {} };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const { ProcessingImagePanel } = await vite.ssrLoadModule("/src/components/ProcessingImagePanel.tsx");
    let mounted = 0;
    let unmounted = 0;
    let captures = 0;
    function Live() {
      useEffect(() => { mounted++; return () => { unmounted++; }; }, []);
      return React.createElement("canvas", { "data-live": true });
    }
    store.dispatch(scan.streamStarted());
    const capture = async () => `data:image/png;base64,frozen-${++captures}`;
    await act(async () => { renderer = create(React.createElement(Provider, { store },
      React.createElement(ProcessingImagePanel, { headerHost: null, capture }, React.createElement(Live))),
      { createNodeMock: () => ({}) }); });
    const grid = () => renderer.root.findByProps({ id: "processing-image-panel-grid" });
    const split = () => renderer.root.findByProps({ className: "btn btn--primary image-panel-card__layout-button" });
    assert.equal(grid().props.className, "image-panel-grid image-panel-grid--1");
    await act(async () => { split().props.onClick(); });
    assert.equal(grid().props.className, "image-panel-grid image-panel-grid--2");
    assert.equal(renderer.root.findByType("img").props.src, "data:image/png;base64,frozen-1");
    assert.equal(store.getState().scan.phase, "running", "Split does not stop acquisition");
    assert.equal(mounted, 1);
    assert.equal(unmounted, 0, "moving the live pane must not remount its canvas");
    await act(async () => { store.dispatch(scan.streamStopping()); });
    await act(async () => { store.dispatch(scan.streamCompleted()); });
    assert.equal(grid().props.className, "image-panel-grid image-panel-grid--3");
    assert.equal(renderer.root.findAllByType("img").length, 2);
    const lock = renderer.root.findByProps({ className: "checkbox vacuum-switch app-switch image-panel-card__layout-lock" }).findByType("input");
    await act(async () => { lock.props.onChange({ target: { checked: false } }); });
    assert.equal(grid().props.className, "image-panel-grid image-panel-grid--1");
    await act(async () => { split().props.onClick(); });
    assert.equal(grid().props.className, "image-panel-grid image-panel-grid--3");
    assert.equal(captures, 2, "restoring the locked layout reuses the frozen snapshots");
    const recycle = renderer.root.findAllByProps({ className: "btn btn--ghost image-panel-grid__recycle" })[0];
    await act(async () => { recycle.props.onClick({ stopPropagation() {} }); });
    assert.equal(renderer.root.findAllByType("img").length, 1);
    assert.equal(unmounted, 0);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    globalThis.window = originalWindow;
  }
});
