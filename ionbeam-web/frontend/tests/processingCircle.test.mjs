import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Circle draws an open outline on release, cancels drafts and clears its area", async () => {
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: (key, fn) => listeners.set(key, fn),
    removeEventListener: (key) => listeners.delete(key),
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { PatternOverlay } = await vite.ssrLoadModule("/src/components/PatternOverlay.tsx");
    const { ProcessingPatternsPanel, ProcessingPatternCards } = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const { updateROI } = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const actions = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const spec = { key: "circle", caption: "Circle", model: "CircleModel", icon: "patternCircle", roi: "circle", parameters: [] };
    store.dispatch(actions.fetchProcessingPatterns.fulfilled({ patterns: [spec] }, "test"));
    store.dispatch(updateROI({ x_origin: 0, x_end: 100, y_origin: 0, y_end: 200 }));
    const api = { pointFromClient: (x, y) => ({ x, y }), toWorld: (p) => ({ x: p.x / 2, y: p.y / 2 }) };
    const focusCalls = [];
    const scrollCalls = [];
    await act(async () => { renderer = create(React.createElement(Provider, { store },
      React.createElement(React.Fragment, null,
        React.createElement(ProcessingPatternsPanel, { disabled: false }),
        React.createElement(ProcessingPatternCards, { disabled: false }),
        React.createElement(PatternOverlay, { disabled: false, api }))), {
      createNodeMock: (element) => element.props["data-pattern"] ? {
        focus: (options) => focusCalls.push([element.props["data-pattern"], options]),
        scrollIntoView: (options) => scrollCalls.push([element.props["data-pattern"], options]),
      } : null,
    }); });
    assert.deepEqual(focusCalls, [], "collapsed cards do not steal focus");
    const icon = renderer.root.findByProps({ className: "pattern-strip__btn" });
    await act(async () => { icon.props.onClick(); });
    const card = renderer.root.findByProps({ "data-pattern": "circle" });
    assert.equal(icon.props["aria-controls"], card.props.id);
    assert.equal(card.props.tabIndex, -1);
    assert.deepEqual(focusCalls, [["circle", { preventScroll: true }]]);
    assert.deepEqual(scrollCalls, [["circle", { block: "nearest", inline: "nearest" }]]);
    assert.equal(store.getState().processing.activeKey, "circle");
    const overlay = () => renderer.root.findByProps({ "data-testid": "pattern-overlay" });
    const event = (x, y, button = 0) => ({ clientX: x, clientY: y, button, pointerId: 1,
      preventDefault() {}, currentTarget: { setPointerCapture() {} } });
    const pointer = async (name, e) => act(async () => { overlay().props[name](e); });
    const roi = () => store.getState().processing.instances.circle.roi;

    await pointer("onPointerDown", event(100, 100));
    await pointer("onPointerMove", event(160, 100));
    assert.equal(roi(), null, "draft remains uncommitted until release");
    assert.equal(renderer.root.findByType("ellipse").props.strokeDasharray, "5 4");
    await pointer("onPointerUp", event(180, 100));
    assert.deepEqual(roi(), { cx: 50, cy: 50, radius: 40 }, "release uses the final pointer position");
    const ellipse = renderer.root.findByType("ellipse");
    assert.equal(ellipse.props.fill, "none");
    assert.equal(ellipse.props.rx / ellipse.props.ry, 2, "world radius respects differing axis scales");
    assert.equal(ellipse.props.strokeDasharray, undefined, "circle finishes without an inner-radius click");
    const saved = roi();
    await pointer("onPointerDown", event(100, 100));
    await pointer("onPointerUp", event(100, 100));
    assert.deepEqual(roi(), saved, "a click preserves the existing circle");
    for (const cancel of [
      () => listeners.get("keydown")({ key: "Escape" }),
      () => overlay().props.onPointerDown(event(160, 100, 2)),
    ]) {
      await pointer("onPointerDown", event(100, 100));
      await pointer("onPointerMove", event(160, 100));
      await act(async () => { cancel(); });
      await pointer("onPointerUp", event(160, 100));
      assert.deepEqual(roi(), saved);
      assert.equal(renderer.root.findAllByType("ellipse").length, 1);
    }
    await act(async () => { store.dispatch(actions.clearPatternRoi("circle")); });
    assert.equal(roi(), null);
    assert.equal(renderer.root.findAllByType("ellipse").length, 0);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    globalThis.window = originalWindow;
  }
});
