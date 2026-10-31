import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Split captures a stopped live image before its deferred notification and retains result metadata", async () => {
  const originals = Object.fromEntries(["window", "fetch", "FileReader", "requestAnimationFrame", "cancelAnimationFrame"]
    .map((key) => [key, globalThis[key]]));
  const frames = new Map();
  let nextFrame = 0;
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  let allowServerFigure = false;
  const figureBytes = Buffer.from("server-figure");
  globalThis.fetch = async () => {
    if (!allowServerFigure) throw new Error("capturing existing pixels must not fetch a server figure");
    return { ok: true, blob: async () => new Blob([figureBytes], { type: "image/png" }) };
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      void blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      });
    }
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  const paintedCanvases = [];
  const canvasMock = (element) => {
    if (element.type !== "canvas") return null;
    const canvas = { width: element.props.width ?? 4, height: element.props.height ?? 4, pixels: null };
    const context = {
      canvas,
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image) => { canvas.pixels = image.data.slice(); paintedCanvases.push(canvas); },
      clearRect() { canvas.pixels = null; },
    };
    canvas.getContext = () => context;
    canvas.toDataURL = () => `data:image/png;base64,${Buffer.from(canvas.pixels ?? []).toString("base64")}`;
    return canvas;
  };
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { ImageCanvas } = await vite.ssrLoadModule("/src/components/ImageCanvas.tsx");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
    store.dispatch(scan.setStreamTransforms({ xflip: false, yflip: false, rotate90: false }));
    store.dispatch(scan.updateROI({ raster_show_scan_path: false, vector_show_scan_path: false }));
    for (const kind of ["raster", "vector"]) {
      const captureRef = { current: null };
      const captureTargetImageRef = { current: null };
      const notifications = [];
      const props = { kind, captureRef, captureTargetImageRef, onRenderedImageChange: (...args) => notifications.push(args) };
      const render = (extra = {}) => React.createElement(Provider, { store }, React.createElement(ImageCanvas, { ...props, ...extra }));
      if (kind === "raster") {
        store.dispatch(image.resetRaster({ resolution: 4 }));
        store.dispatch(image.appendRaster({ pixels: Uint16Array.from({ length: 16 }, (_, i) => i * 1000) }));
      } else {
        store.dispatch(image.setupVector({ edge: 4, pattern: "default", scanPath: "horizontal_sawtooth" }));
        store.dispatch(image.appendVectorSamples({ values: Uint16Array.from({ length: 16 }, (_, i) => i * 1000) }));
      }
      store.dispatch(scan.streamStarted());
      store.dispatch(scan.scanParamsCaptured({ kind, items: [{ id: "resolution", labelKey: "scan.resolution", value: "4 × 4" }] }));
      await act(async () => { renderer = create(render(), { createNodeMock: canvasMock }); });
      await act(async () => { store.dispatch(scan.streamReset()); });
      assert.ok(frames.size > 0, "the stopped-scan notification is still deferred");
      assert.equal(notifications.filter(([, url]) => url).length, 0);
      const captured = captureRef.current();
      assert.equal(captured.kind, kind);
      assert.ok(captured.imageUrl.startsWith("data:image/png;base64,"));
      assert.equal(await captureTargetImageRef.current(), captured.imageUrl);
      await act(async () => {
        renderer.update(render({ imageLayout: 2, imageSlots: [captured.imageUrl, null], selectedPane: 1, scanTargetPane: 1 }));
      });
      const archived = renderer.root.findByProps({ className: "canvas-stage image-panel-grid__archived-stage" });
      const archivedCanvas = paintedCanvases.at(-1);
      const pixels = archivedCanvas.pixels.slice();
      assert.ok(pixels.some((value) => value > 0));
      assert.ok(archived.findAllByProps({ className: "canvas-scan-params__value" })
        .some((node) => node.children.includes("4 × 4")));
      // A subsequent acquisition must not overwrite the carried-over result.
      await act(async () => {
        if (kind === "raster") store.dispatch(image.resetRaster({ resolution: 4 }));
        else store.dispatch(image.resetVector());
      });
      assert.deepEqual(archivedCanvas.pixels, pixels);
      // Server figures use revocable blob URLs. The asynchronous patch path
      // must return a self-contained image for a pane that outlives the source.
      allowServerFigure = true;
      await act(async () => {
        renderer.update(render());
        store.dispatch(scan.streamCompleted({ kind, chunks: 1, image_filename: "result.png", csv_filename: null }));
      });
      const persisted = await captureTargetImageRef.current();
      assert.equal(persisted, `data:image/png;base64,${figureBytes.toString("base64")}`);
      await act(async () => { renderer.unmount(); });
      assert.equal(captureRef.current, null);
      assert.equal(captureTargetImageRef.current, null);
      renderer = null;
      allowServerFigure = false;
      frames.clear();
    }
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
