import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("Split captures running and stopped scans, preserves snapshots, and retains result metadata", async () => {
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
  globalThis.fetch = async (url) => {
    if (!allowServerFigure) throw new Error("capturing existing pixels must not fetch a server figure");
    assert.match(String(url), /^(data:image\/png|blob:)/, "server-only results must use their workspace snapshot");
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
    if (element.props.className === "scan-roi-layer") {
      return { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    }
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
    for (const [kind, running] of [["raster", true], ["vector", true], ["raster", false], ["vector", false]]) {
      store.dispatch(scan.setInfiniteActive(running));
      store.dispatch(scan.updateROI({ roi_scan_enabled: true, x_origin: 0, x_end: 100, y_origin: 0, y_end: 100,
        scan_regions: [{ x_start: 10, x_end: 20, y_start: 10, y_end: 20 }], active_scan_region: 0 }));
      const captureRef = { current: null };
      const captureTargetImageRef = { current: null };
      const notifications = [];
      const props = { kind, captureRef, captureTargetImageRef, onRenderedImageChange: (...args) => notifications.push(args) };
      const render = (extra = {}) => React.createElement(Provider, { store }, React.createElement(ImageCanvas, { ...props, ...extra }));
      if (kind === "raster") {
        store.dispatch(image.resetRaster({ resolution: 4 }));
        store.dispatch(image.appendRaster({ pixels: Uint16Array.from({ length: running ? 8 : 16 }, (_, i) => i * 1000) }));
      } else {
        store.dispatch(image.setupVector({ edge: 4, pattern: "default", scanPath: "horizontal_sawtooth" }));
        store.dispatch(image.appendVectorSamples({ values: Uint16Array.from({ length: running ? 8 : 16 }, (_, i) => i * 1000) }));
      }
      store.dispatch(scan.streamStarted());
      store.dispatch(scan.scanParamsCaptured({ kind, items: [{ id: "resolution", labelKey: "scan.resolution", value: "4 × 4" }] }));
      await act(async () => { renderer = create(render(), { createNodeMock: canvasMock }); });
      if (!running) {
        await act(async () => { store.dispatch(scan.streamReset()); });
        assert.ok(frames.size > 0, "the stopped-scan notification is still deferred");
      }
      assert.equal(notifications.filter(([, url]) => url).length, 0);
      assert.equal(renderer.root.findAllByProps({ role: "toolbar" }).length > 0, !running,
        "the edit toolbox appears for a stopped Live frame and stays hidden during scanning");
      const captured = captureRef.current();
      assert.equal(captured.kind, kind);
      assert.ok(captured.imageUrl.startsWith("data:image/png;base64,"));
      assert.equal(await captureTargetImageRef.current(), captured.imageUrl);
      await act(async () => {
        renderer.update(render({ imageLayout: 2, imageSlots: [captured.imageUrl, null], selectedPane: 1, scanTargetPane: 1 }));
      });
      const archived = renderer.root.findByProps({ className: "canvas-stage image-panel-grid__archived-stage" });
      assert.equal(archived.findAllByProps({ className: "scan-roi-layer" }).length, 0);
      const roiLayer = () => renderer.root.findByProps({ className: "scan-roi-layer" });
      assert.equal(roiLayer().props["data-editing"], "true");
      assert.equal(roiLayer().findAllByProps({ className: "scan-roi-layer__region" }).length, 1);
      const pointer = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
        target: { closest: () => null }, currentTarget: { setPointerCapture() {} }, preventDefault() {} });
      await act(async () => { roiLayer().props.onPointerDown(pointer(15, 15)); });
      await act(async () => { roiLayer().props.onPointerMove(pointer(25, 25)); });
      await act(async () => { roiLayer().props.onPointerUp(pointer(25, 25)); });
      assert.deepEqual(store.getState().scan.roi.scan_regions[0], { x_start: 20, x_end: 30, y_start: 20, y_end: 30 });
      const resizePointer = pointer(30, 30);
      resizePointer.target.closest = (selector) => selector === "[data-roi-handle]"
        ? { dataset: { roiIndex: "0", roiHandle: "se" } } : null;
      await act(async () => { roiLayer().props.onPointerDown(resizePointer); });
      await act(async () => { roiLayer().props.onPointerMove(pointer(35, 35)); });
      await act(async () => { roiLayer().props.onPointerUp(pointer(35, 35)); });
      assert.deepEqual(store.getState().scan.roi.scan_regions[0], { x_start: 20, x_end: 35, y_start: 20, y_end: 35 });
      await act(async () => { roiLayer().props.onPointerDown(pointer(40, 40)); });
      await act(async () => { roiLayer().props.onPointerMove(pointer(70, 70)); });
      await act(async () => { roiLayer().props.onPointerUp(pointer(70, 70)); });
      assert.deepEqual(store.getState().scan.roi.scan_regions[1], { x_start: 40, x_end: 70, y_start: 40, y_end: 70 });
      const archivedCanvas = paintedCanvases.at(-1);
      const pixels = archivedCanvas.pixels.slice();
      assert.ok(pixels.some((value) => value > 0));
      assert.ok(archived.findAllByProps({ className: "canvas-scan-params__value" })
        .some((node) => node.children.includes("4 × 4")));
      if (running) {
        const notificationsBeforeRestart = notifications.length;
        await act(async () => {
          store.dispatch(scan.setStreamRestarting(true));
          store.dispatch(scan.streamStopping());
        });
        await act(async () => { store.dispatch(scan.streamReset()); });
        // Parallel/Sequential transport handovers must not archive a result
        // during their idle interval or acquire a new scan identity.
        assert.equal(notifications.length, notificationsBeforeRestart);
        await act(async () => { store.dispatch(scan.streamStarted()); });
        assert.equal(captureRef.current().scanId, captured.scanId);
        assert.equal(store.getState().scan.streamRestarting, false);
        const buffer = kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage;
        await act(async () => {
          if (kind === "raster") store.dispatch(image.appendRaster({ pixels: Uint16Array.of(16000, 15000) }));
          else store.dispatch(image.appendVectorSamples({ values: Uint16Array.of(16000, 15000) }));
        });
        assert.equal(store.getState().scan.phase, "running", "Split must leave acquisition running");
        assert.equal(kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage, buffer);
        assert.equal(buffer[8], 16000, "new samples must reach the live pane after Split");
        assert.deepEqual(archivedCanvas.pixels, pixels, "live samples must not change the snapshot");
      }
      // A subsequent acquisition must not overwrite the carried-over result.
      await act(async () => {
        if (kind === "raster") store.dispatch(image.resetRaster({ resolution: 4 }));
        else store.dispatch(image.resetVector());
      });
      assert.deepEqual(archivedCanvas.pixels, pixels);
      // Server-only validated results use their captured workspace snapshot.
      // The asynchronous patch path must keep it self-contained after Split.
      allowServerFigure = true;
      await act(async () => {
        renderer.update(render());
        const result = { kind, resolution: 4, chunks: 1, image_filename: "result.png", csv_filename: null,
          artifacts: { csvDataUrl: null, figureDataUrl: `data:image/png;base64,${figureBytes.toString("base64")}` } };
        const run = kind === "raster" ? scan.runRasterValidated : scan.runVectorValidated;
        store.dispatch(run.fulfilled(result, "workspace-result", kind === "raster" ? store.getState().scan.raster : store.getState().scan.vector));
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
    // Sequential passes change the active ROI, but red filter marks belong
    // to all acquired regions and must survive the next loop's background.
    store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: false, vector: {} } });
    store.dispatch(scan.updateVector({ vector_resolution: 4 }));
    store.dispatch(scan.setInfiniteActive(true));
    store.dispatch(scan.updateROI({ roi_scan_enabled: true,
      x_origin: 0, x_end: 16383, y_origin: 0, y_end: 16383,
      scan_regions: [
        { x_start: 0, x_end: 8191, y_start: 0, y_end: 8191 },
        { x_start: 8192, x_end: 16383, y_start: 8192, y_end: 16383 },
      ] }));
    store.dispatch(scan.streamStarted());
    const regions = store.getState().scan.roi.scan_regions;
    await act(async () => {
      renderer = create(React.createElement(Provider, { store }, React.createElement(ImageCanvas, {
        kind: "vector", vectorGrayScaleSelection: [90, 110], vectorGrayScaleSkipped: false,
      })), { createNodeMock: canvasMock });
    });
    const redCount = () => {
      const pixels = paintedCanvases.at(-1).pixels;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i + 1] && pixels[i] > pixels[i + 2]) count++;
      return count;
    };
    for (let loop = 0; loop < 2; loop++) {
      for (const [index, roi] of regions.entries()) {
        await act(async () => {
          store.dispatch(image.setupVector({ pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
            roi, preserveImage: loop > 0 || index > 0 }));
          store.dispatch(image.appendVectorSamples({ values: new Uint16Array(16).fill(100 * 256) }));
        });
        assert.equal(redCount(), loop === 0 && index === 0 ? 4 : 8);
      }
      await act(async () => {
        store.dispatch(image.setupVector({ pattern: "default", scanPath: "horizontal_sawtooth", edge: 4,
          compositeROIs: regions, preserveImage: true }));
        store.dispatch(image.appendVectorSamples({ values: new Uint16Array(16).fill(50 * 256) }));
      });
      assert.equal(redCount(), 8, "background pass must retain dots from both ROIs");
    }
    // Each Sequential ROI pass ends in "completed", but only Stop produces a
    // result. Encoding and archiving the canvas after every pass froze the
    // browser on long Live runs.
    await act(async () => { renderer.unmount(); });
    renderer = null;
    store.dispatch(scan.streamReset());
    store.dispatch(scan.setInfiniteActive(true));
    store.dispatch(scan.streamStarted());
    const liveNotifications = [];
    let encodes = 0;
    const countingCanvas = (element) => {
      const canvas = canvasMock(element);
      if (canvas?.toDataURL) { const encode = canvas.toDataURL; canvas.toDataURL = () => { encodes++; return encode(); }; }
      return canvas;
    };
    await act(async () => {
      renderer = create(React.createElement(Provider, { store }, React.createElement(ImageCanvas, {
        kind: "vector", onRenderedImageChange: (...args) => liveNotifications.push(args),
      })), { createNodeMock: countingCanvas });
    });
    const runFrames = async () => act(async () => { for (const callback of [...frames.values()]) callback(0); frames.clear(); });
    for (let pass = 0; pass < 3; pass++) {
      await act(async () => {
        store.dispatch(image.appendVectorSamples({ values: new Uint16Array(16).fill(100 * 256) }));
        store.dispatch(scan.streamCompleted({ kind: "vector", chunks: 1, image_filename: null, csv_filename: null }));
      });
      await runFrames();
      await act(async () => { store.dispatch(scan.streamStarted()); });
    }
    assert.equal(encodes, 0, "intermediate Live passes must not encode the canvas");
    assert.equal(liveNotifications.filter(([, url]) => url).length, 0, "intermediate Live passes are not results");
    await act(async () => {
      store.dispatch(scan.setInfiniteActive(false));
      store.dispatch(scan.streamReset());
    });
    await runFrames();
    assert.equal(liveNotifications.filter(([, url]) => url).length, 1, "Stop archives the final image once");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
