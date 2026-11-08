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
      const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
      store.dispatch(scan.updateROI({ selection: null, raster_show_scan_path: kind === "raster", vector_show_scan_path: kind === "vector" }));
      store.dispatch(scan.streamStarted());
      await act(async () => {
        renderer = create(React.createElement(Provider, { store }, React.createElement(ROIEditor,
          { disabled: true, variant: "canvas", processingPreview: kind })), {
          createNodeMock: (node) => node.props.className === "roi-canvas-layer roi-canvas-layer--scan-path" ? canvas : null,
        });
      });
      const scaleBefore = renderer.root.findByProps({ className: "canvas-image-scale" }).props;
      assert.ok(scaleBefore["aria-label"], "Processing displays the physical scale bar");
      await act(async () => { store.dispatch(scan.setScanZoom(2)); });
      const scaleAfter = renderer.root.findByProps({ className: "canvas-image-scale" }).props;
      assert.equal(scaleAfter.style.width, scaleBefore.style.width, "live Zoom keeps the bar width fixed");
      assert.equal(parseFloat(scaleAfter["aria-label"]), parseFloat(scaleBefore["aria-label"]) / 2);
      assert.ok(operations.some(([op]) => op === "stroke"), "the active sweep must be visible without a selection");
      assert.ok(operations.some(([op]) => op === "arc"), "the marker remains visible at a live frame boundary (cursor zero)");
      assert.equal(callbacks.size, 1, "one animation loop follows the live scan");
      const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
      await act(async () => {
        store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [
          { key: "ring", model: "RingModel", caption: "Ring", icon: "ring", roi: "ring", parameters: [] },
          { key: "free", model: "FreeHandModel", caption: "Free", icon: "free", roi: "polygon", parameters: [] },
        ] }, "test"));
        store.dispatch(processing.setPatternRoi({ key: "ring", roi: { cx: 100, cy: 100, r_outer: 30, r_inner: 10 } }));
        store.dispatch(processing.setPatternRoi({ key: "free", roi: { points: [[150, 150], [180, 150], [170, 180]] } }));
      });
      // Drawn shapes must not clip a full-field acquisition.
      const setup = (roi = null, parallelROIs = null) => kind === "raster"
        ? image.resetRaster({ resolution: 128, roi, parallelROIs, continuous: true })
        : image.setupVector({ pattern: "default", edge: 128, roi, parallelROIs,
            continuous: true, scanPath: "horizontal_sawtooth" });
      const assertFullField = () => {
        assert.equal(operations.filter(([op]) => op === "ellipse").length, 0,
          "full-field sweep ignores the ring, including its hole");
        assert.equal(operations.filter(([op]) => op === "closePath").length, 0,
          "full-field sweep ignores the freehand outline");
        const rectangles = operations.filter(([op]) => op === "rect");
        assert.deepEqual(rectangles, [["rect", 0, 0, 640, 640]], "one full-canvas sweep, not parallel ROI sweeps");
        const lineXs = operations.filter(([op]) => op === "lineTo").map(([,x]) => x);
        assert.ok(lineXs.includes(639), "scan path crosses the full canvas width");
      };
      operations.length = 0;
      await act(async () => { store.dispatch(setup()); });
      assertFullField();
      const region = { x_start: 4096, x_end: 8191, y_start: 4096, y_end: 8191 };
      const other = { x_start: 8192, x_end: 12287, y_start: 8192, y_end: 12287 };
      operations.length = 0;
      await act(async () => { store.dispatch(setup(null, [region, other])); });
      const ellipses = operations.filter(([op]) => op === "ellipse");
      assert.ok(ellipses.some((op) => op.at(-1) === true), "ring hole clips in the reverse direction");
      assert.ok(ellipses.some((op) => op.at(-1) === false), "ring exterior clips the sweep");
      assert.ok(operations.some(([op]) => op === "closePath"), "freehand outline closes the clipping mask");
      assert.equal(callbacks.size, 1, "editing patterns replaces the animation loop");

      // Sequential acquisition draws only its active ROI. Turning ROI Scan
      // off clears both display mappings while the two pattern shapes remain.
      operations.length = 0;
      await act(async () => { store.dispatch(setup(region)); });
      assert.equal(operations.filter(([op]) => op === "rect").length, 1);
      assert.ok(operations.some(([op]) => op === "ellipse"), "ROI sweep retains its shape mask");
      operations.length = 0;
      await act(async () => { store.dispatch(setup()); });
      assertFullField();
      assert.ok(store.getState().processing.instances.ring.roi);
      assert.ok(store.getState().processing.instances.free.roi);

      if (kind === "vector") {
        operations.length = 0;
        await act(async () => {
          store.dispatch(image.setupVector({pattern:"custom",edge:128,
            roi:{x_start:4096,x_end:8192,y_start:4096,y_end:8192},
            points:[[5000,6000,2,false,1],[6000,6000,2,false,1],[5000,7000,2,false,1],[6000,7000,2,false,1]],
            pointPixelIndices:[80*128+20,80*128+21,81*128+20,81*128+21],scanPath:"horizontal_sawtooth"}));
          store.dispatch(image.appendVectorSamples({values:new Uint16Array([40<<8,40<<8,40<<8])}));
        });
        assert.ok(operations.some(([op]) => op === "stroke"), "workflow's custom point list still draws a scan sweep");
        assert.ok(operations.some(([op, x, y]) => op === "arc" && Math.abs(y - 81/127*639) < 0.01),
          "workflow marker uses actual point pixels rather than its compact cursor as a raster offset");
      }

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
