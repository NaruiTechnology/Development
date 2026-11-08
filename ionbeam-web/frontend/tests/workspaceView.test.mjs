import test from "node:test";
import assert from "node:assert/strict";
import React, { useEffect, useState } from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("hidden workspace viewers retain drawings and do not receive active workspace shortcuts", async () => {
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { WorkspaceView } = await vite.ssrLoadModule("/src/components/WorkspaceView.tsx");
    const { PatternOverlay } = await vite.ssrLoadModule("/src/components/PatternOverlay.tsx");
    const { getWorkspaceStore } = await vite.ssrLoadModule("/src/store/index.ts");
    const actions = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const store = getWorkspaceStore("processing");
    store.dispatch(actions.fetchProcessingPatterns.fulfilled({ patterns: [
      { key: "circle", caption: "Circle", model: "CircleModel", icon: "patternCircle", roi: "circle", parameters: [] },
    ] }, "test"));
    store.dispatch(actions.setPatternEnabled({ key: "circle", enabled: true }));
    store.dispatch(actions.selectPattern("circle"));
    const first = { cx: 30, cy: 30, radius: 10 };
    const second = { cx: 40, cy: 40, radius: 20 };
    store.dispatch(actions.setPatternRoi({ key: "circle", roi: first }));
    store.dispatch(actions.setPatternRoi({ key: "circle", roi: second }));
    let mounts = 0;
    let unmounts = 0;
    function Drawing() {
      const [value, setValue] = useState(1);
      useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      return React.createElement("button", { onClick: () => setValue(value + 1) }, String(value));
    }
    const api = { pointFromClient: (x, y) => ({ x, y }), toWorld: p => p };
    const view = active => React.createElement(WorkspaceView, { workspace: "processing", active },
      React.createElement(React.Fragment, null, React.createElement(Drawing), React.createElement(PatternOverlay, { disabled: false, api })));
    await act(async () => { renderer = create(view(true)); });
    await act(async () => { renderer.root.findByType("button").props.onClick(); });
    await act(async () => { renderer.update(view(false)); });
    const undo = { key: "z", ctrlKey: true, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} };
    await act(async () => { for (const handler of listeners.get("keydown") ?? []) handler(undo); });
    assert.deepEqual(store.getState().processing.instances.circle.roi, second, "SCAN shortcuts must not undo hidden Processing geometry");
    await act(async () => { renderer.update(view(true)); });
    assert.equal(renderer.root.findByType("button").props.children, "2", "viewer-local drawings and controls survive navigation");
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
    await act(async () => { for (const handler of listeners.get("keydown") ?? []) handler(undo); });
    assert.deepEqual(store.getState().processing.instances.circle.roi, first, "Processing receives its own active shortcut");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    globalThis.window = originalWindow;
  }
});
