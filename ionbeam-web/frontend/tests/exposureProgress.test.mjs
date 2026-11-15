import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("exposure canvas progress weights patterns and passes and holds during View", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {location: {hostname: "x", protocol: "http:", host: "x"},
    localStorage: {getItem: () => null, setItem() {}}, addEventListener() {}, removeEventListener() {}};
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer;
  try {
    const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
    const store = getWorkspaceStore("processing");
    const exposure = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const {ExposureLatticeProgress} = await vite.ssrLoadModule("/src/components/ExposureLatticeOverlay.tsx");
    await act(async () => { renderer = create(React.createElement(Provider, {store}, React.createElement(ExposureLatticeProgress))); });
    const percent = () => renderer.root.findByProps({role: "progressbar"}).props["aria-valuenow"];
    assert.equal(percent(), 0);
    const node = (id, count, passes) => ({id, status: "upcoming", exposure: {plan: {count, passes}}});
    await act(async () => {
      store.dispatch(exposure.exposurePrepared([node("a", 100, 2), node("b", 50, 2)]));
      store.dispatch(exposure.exposureStepStarted("a"));
      store.dispatch(exposure.exposureStepStarted("b"));
      store.dispatch(exposure.exposureSamplesReceived({id: "a", count: 100}));
      store.dispatch(exposure.exposureSamplesReceived({id: "b", count: 50}));
    });
    assert.equal(percent(), 50, "counts samples across both parallel patterns and both passes");
    await act(async () => {
      store.dispatch(exposure.exposureViewChanged({phase: "scanning"}));
      store.dispatch(exposure.exposureViewSamplesReceived(1000));
    });
    assert.equal(percent(), 50, "View samples do not advance exposure progress");
    await act(async () => store.dispatch(exposure.exposureStepCompleted("a")));
    assert.equal(percent(), 83);
    await act(async () => store.dispatch(exposure.exposureStepCompleted("b")));
    assert.equal(percent(), 100);
    await act(async () => store.dispatch(exposure.exposurePreparing()));
    await act(async () => store.dispatch(exposure.exposurePrepared([node("c", 100, 1)])));
    assert.equal(percent(), 0, "a new run resets the bar");
  } finally {
    await act(async () => renderer?.unmount());
    await vite.close();
    globalThis.window = previousWindow;
  }
});
