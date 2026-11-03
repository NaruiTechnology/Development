import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("the Load image card has a Clear image button that drops the image and its regions", async () => {
  const originals = Object.fromEntries(["window", "fetch", "WebSocket", "Image"].map((key) => [key, globalThis[key]]));
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  globalThis.Image = class { set src(_) {} };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "" });
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { SimulationImageCard } = await vite.ssrLoadModule("/src/components/SimulationImageCard.tsx");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
    const changes = [];
    await act(async () => {
      renderer = create(React.createElement(Provider, { store },
        React.createElement(SimulationImageCard, { disabled: false, onImageChange: (url) => changes.push(url) })));
    });
    const clearButton = () => renderer.root.findAllByType("button")
      .find((node) => node.props.children?.some?.((child) => child === translate("en", "roi.clearImage")));
    assert.ok(clearButton(), "Clear image button is shown");
    assert.equal(clearButton().props.disabled, true, "nothing to clear yet");
    store.dispatch(scan.updateROI({
      imageName: "a.png", imageDataUrl: "data:image/png;base64,AAAA", imageKind: "file",
      scan_regions: [{ x_start: 10, x_end: 30, y_start: 10, y_end: 30 }], roi_scan_enabled: true,
    }));
    await act(async () => {});
    assert.equal(clearButton().props.disabled, false);
    await act(async () => { clearButton().props.onClick(); });
    const roi = store.getState().scan.roi;
    assert.equal(roi.imageDataUrl, null);
    assert.equal(roi.imageKind, "none");
    assert.deepEqual(roi.scan_regions, []);
    assert.deepEqual(changes, [null]);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
