import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("pattern timeline follows exposure start, elapsed time, completion and stop", async () => {
  const previousWindow = globalThis.window;
  const previousNow = Date.now;
  let now = 1000, tick;
  Date.now = () => now;
  globalThis.window = {
    location: { hostname: "example.test", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: fn => { tick = fn; return 1; },
    clearInterval: () => { tick = undefined; },
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { ProcessingWorkflowPanel } = await vite.ssrLoadModule("/src/components/ProcessingWorkflowPanel.tsx");
    const exposure = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const node = (id, caption) => ({ id, caption, pattern: "Ring", action: caption,
      status: "upcoming", threshold: null, spot: 0, total: 0 });
    store.dispatch(processing.setWorkflowProgress([node("ring:default", "Scan ROI")]));
    await act(async () => {
      renderer = create(React.createElement(Provider, { store },
        React.createElement(ProcessingWorkflowPanel, { patternKey: "ring" })));
    });
    const elapsed = () => renderer.root.findByProps({className: "processing-workflow__elapsed"}).children.join("");
    const status = name => renderer.root.findAllByProps({className: `processing-workflow__node processing-workflow__node--${name}`});
    assert.equal(status("upcoming").length, 1, "scan workflow remains available before exposure");
    assert.equal(elapsed(), "Elapsed: 00:00.0");
    await act(async () => {
      store.dispatch(exposure.exposurePrepared([node("ring:0:exposure", "Expose ring")]));
      store.dispatch(exposure.exposureStepStarted("ring:0:exposure"));
    });
    assert.equal(status("current").length, 1);
    assert.equal(renderer.root.findByProps({"aria-current": "step"}).type, "li");
    assert.equal(renderer.root.findAllByProps({className: "processing-workflow__step"}).length, 0);
    assert.equal(renderer.root.findByProps({className: "processing-workflow__number"}).props.title, "Expose ring: current");
    await act(async () => { now = 2600; tick(); });
    assert.equal(elapsed(), "Elapsed: 00:01.6");
    await act(async () => store.dispatch(exposure.exposureStepCompleted("ring:0:exposure")));
    assert.equal(status("completed").length, 1);
    assert.equal(renderer.root.findByProps({className: "processing-workflow__end"}).props["data-completed"], true);
    assert.equal(tick, undefined, "completed timer is released");
    now = 9000;
    assert.equal(elapsed(), "Elapsed: 00:01.6", "completed duration is frozen");
    await act(async () => {
      store.dispatch(exposure.exposurePrepared([node("ring:0:exposure", "Expose ring")]));
      store.dispatch(exposure.exposureStepStarted("ring:0:exposure"));
    });
    await act(async () => { now = 9500; store.dispatch(exposure.exposureFinished({phase: "stopped"})); });
    assert.equal(status("stopped").length, 1);
    assert.equal(elapsed(), "Elapsed: 00:00.5");
    assert.equal(tick, undefined);
    assert.equal(renderer.root.findByProps({className: "processing-workflow__end"}).props["data-completed"], false);
  } finally {
    await act(async () => renderer?.unmount());
    await vite.close();
    globalThis.window = previousWindow;
    Date.now = previousNow;
  }
});
