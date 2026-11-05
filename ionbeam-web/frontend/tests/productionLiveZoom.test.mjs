import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

for (const kind of ["raster", "vector"]) {
  for (const count of [0, 1, 2]) {
    test(`production ${kind} Live updates Zoom in-band for ${count} ROI(s) and preserves canvas background`, async () => {
      const keys = ["window", "fetch", "WebSocket", "requestAnimationFrame", "cancelAnimationFrame"];
      const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
      const sockets = [];
      const pendingAborts = [];
      let holdAborts = true;
      const pendingStarts = [];
      let holdRestartAuth = false;
      globalThis.window = {
        location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
        localStorage: { getItem: () => null, setItem() {} },
        addEventListener() {}, removeEventListener() {},
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
        cancelAnimationFrame: clearTimeout,
      };
      globalThis.requestAnimationFrame = window.requestAnimationFrame;
      globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/api/scan/abort") && holdAborts) {
          return new Promise((resolve) => pendingAborts.push(() => resolve({ ok: true, status: 200 })));
        }
        let body = null;
        if (String(url).includes("current-account")) body = { ok: true, registered: true, user: { is_active: true, role: 5 } };
        else if (String(url).includes("equipment")) body = [];
        const response = { ok: true, status: 200, json: async () => body, text: async () => "" };
        if (String(url).includes("current-account") && holdRestartAuth) {
          return new Promise((resolve) => pendingStarts.push(() => resolve(response)));
        }
        return response;
      };
      class Socket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        requests = [];
        constructor() {
          sockets.push(this);
          queueMicrotask(() => { this.readyState = 1; void this.onopen?.(); });
        }
        send(data) {
          const message = JSON.parse(data);
          this.requests.push(message);
          if (message.event === "update_geometry") {
            queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ event: "geometry_updated", id: message.id }) }));
          }
        }
        close(code = 1000) {
          if (this.readyState >= 2) return;
          this.readyState = 2;
          queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code }); });
        }
      }
      globalThis.WebSocket = Socket;
      const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
      let renderer;
      try {
        const { store } = await vite.ssrLoadModule("/src/store/index.ts");
        const { ScanControls } = await vite.ssrLoadModule("/src/components/ScanControls.tsx");
        const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
        const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
        const { scanRegionPixelBounds } = await vite.ssrLoadModule("/src/lib/scanRegions.ts");
        const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
        store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: true, raster: {}, vector: {} } });
        const regions = [
          { x_start: 10, x_end: 30, y_start: 10, y_end: 30 },
          { x_start: 50, x_end: 80, y_start: 50, y_end: 80 },
        ].slice(0, count);
        store.dispatch(scan.updateROI({ scan_regions: regions, roi_scan_enabled: true, scan_zoom: 1 }));
        function Harness() {
          const phase = useSelector((state) => state.scan.phase);
          const active = phase === "running" || phase === "stopping";
          return React.createElement(ScanControls, { kind, disabled: active, scanActive: active, zoomDisabled: false });
        }
        await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(Harness))); });
        const root = renderer.root;
        const button = (key) => root.findAllByType("button").find((node) => node.props.title === translate("en", key));
        const zoom = () => root.findAll((node) => node.props.ariaLabel === translate("en", "scan.zoom") && node.props.onValueChange)[0];
        if (count > 1) {
          await act(async () => {
            root.findByProps({ className: "checkbox vacuum-switch app-switch scan-parallel-toggle" })
              .findByType("input").props.onChange({ target: { checked: true } });
          });
        }
        await act(async () => { await button(kind === "vector" ? "scan.infinite.title.vector" : "scan.infinite.title").props.onClick(); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        assert.equal(sockets.length, 1);
        const first = sockets[0].requests[0];
        const before = first.parallel_rois ?? [first.roi ?? null];
        assert.equal(before.length, Math.max(1, count));
        if (!count) assert.equal(before[0], null);

        // Seed the canvas and make the transport ready for in-band edits.
        await act(async () => {
          const state = store.getState().image;
          const edge = kind === "raster" ? state.resolution : state.vectorEdge;
          const pixels = new Uint16Array(edge * edge * Math.max(1, count)).fill(1234);
          store.dispatch(kind === "raster" ? image.appendRaster({ pixels }) : image.appendVectorSamples({ values: pixels }));
          sockets[0].onmessage({ data: new Uint16Array(edge * edge * Math.max(1, count)).fill(0x1212).buffer });
          await new Promise((resolve) => setTimeout(resolve, 30));
          await zoom().props.onValueChange("2");
          await zoom().props.onValueChange("3");
        });
        await act(async () => { await zoom().props.onValueChange("3"); });
        const frameBefore = (kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage).slice();
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
        assert.equal(pendingAborts.length, 0, "Zoom must not abort acquisition");
        assert.equal(sockets.length, 1, "rapid edits retain the original live stream");
        assert.equal(sockets[0].readyState, Socket.OPEN);
        assert.equal(store.getState().scan.phase, "running");
        assert.equal(store.getState().scan.roi.scan_zoom, 3);
        const updates = sockets[0].requests.filter((request) => request.event === "update_geometry");
        assert.equal(updates.length, 2, "duplicate input does not enqueue another edit");
        const request = updates.at(-1).geometry;
        const after = request.parallel_rois ?? [request.roi];
        const display = kind === "raster"
          ? store.getState().image.rasterParallelROIs ?? [store.getState().image.rasterROI]
          : store.getState().image.vectorParallelROIs ?? [store.getState().image.vectorROI];
        for (let i = 0; i < after.length; i++) {
          const base = before[i] ?? { x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 };
          assert.ok(Math.abs((after[i].x_end - after[i].x_start) * 3 - (base.x_end - base.x_start)) < 4);
          assert.deepEqual(display[i], before[i], "display rectangles stay fixed while DAC bounds shrink");
        }
        assert.deepEqual(kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage, frameBefore);
        const edge = kind === "raster" ? store.getState().image.resolution : store.getState().image.vectorEdge;
        await act(async () => {
          // Equal high/low bytes keep this wire fixture host-endian independent.
          sockets[0].onmessage({ data: new Uint16Array(edge * edge * Math.max(1, count)).fill(0x1616).buffer });
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        const updated = kind === "raster" ? store.getState().image.frame : store.getState().image.vectorImage;
        const bounds = display.map((roi) => scanRegionPixelBounds(roi, edge));
        for (let y = 0; y < edge; y++) {
          for (let x = 0; x < edge; x++) {
            const inRegion = bounds.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);
            assert.equal(updated[y * edge + x], inRegion ? 0x1616 : frameBefore[y * edge + x],
              "new ADC samples fill the original ROI rectangles; background pixels stay unchanged");
          }
        }
        await act(async () => { await zoom().props.onValueChange("1"); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        assert.equal(sockets.length, 1);
        const restored = sockets[0].requests.at(-1).geometry;
        assert.deepEqual(restored.parallel_rois ?? [restored.roi ?? null], before, "Zoom out restores original DAC fields");

        // Layout handovers still need a restart. Exercise realistic asynchronous
        // abort/auth replies, which used to stop or start with stale bounds.
        await act(async () => { store.dispatch(scan.setROIScanEnabled(false)); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
        assert.equal(pendingAborts.length, 1);
        assert.equal(sockets.length, 1, "replacement must wait for the old scan's HTTP abort response");
        await act(async () => { await zoom().props.onValueChange("4"); });
        await act(async () => {
          holdAborts = false;
          holdRestartAuth = true;
          pendingAborts.shift()();
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        assert.equal(pendingStarts.length, 1);
        await act(async () => { await zoom().props.onValueChange("5"); });
        await act(async () => {
          holdRestartAuth = false;
          pendingStarts.shift()();
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        assert.equal(sockets.length, 2);
        const latest = sockets[1].requests[0].roi;
        assert.ok(Math.abs((latest.x_end - latest.x_start) * 5 - 16383) < 5,
          "Zoom edited during a layout handover must reach the new request");
        await act(async () => {
          await zoom().props.onValueChange("2");
          button("scan.stop.title").props.onClick();
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
        assert.equal(sockets.length, 2, "Stop does not reopen the live stream");
      } finally {
        if (renderer) await act(async () => { renderer.unmount(); });
        await vite.close();
        Object.assign(globalThis, originals);
      }
    });
  }
}
