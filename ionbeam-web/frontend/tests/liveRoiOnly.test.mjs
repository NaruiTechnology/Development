import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

// A Live scan with an ROI acquires the ROI only (never the area outside it),
// from its first frame, and a Zoom edit reaches the running scan. Both are
// checked for Production and for simulation, for Raster and Vector.
for (const isProduction of [true, false]) {
  for (const kind of ["raster", "vector"]) {
    test(`Live ROI scan is ROI-only and follows Zoom (${isProduction ? "production" : "simulation"}, ${kind})`, async () => {
      const originals = Object.fromEntries(["window", "fetch", "WebSocket", "requestAnimationFrame", "cancelAnimationFrame"]
        .map((key) => [key, globalThis[key]]));
      const sockets = [];
      globalThis.window = {
        location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
        localStorage: { getItem: () => null, setItem: () => {} },
        addEventListener() {}, removeEventListener() {},
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
        cancelAnimationFrame: clearTimeout,
      };
      globalThis.requestAnimationFrame = window.requestAnimationFrame;
      globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
      globalThis.fetch = async (url) => {
        let body = null;
        if (String(url).includes("current-account")) body = { ok: true, registered: true, user: { is_active: true, role: 5 } };
        else if (String(url).includes("equipment")) body = [];
        return { ok: true, status: 200, json: async () => body, text: async () => "" };
      };
      class Socket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        requests = [];
        constructor() {
          sockets.push(this);
          queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; void this.onopen?.(); } });
        }
        send(data) {
          const message = JSON.parse(data);
          this.requests.push(message);
          // Behave like the service: accept every live geometry update.
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
        const { translate } = await vite.ssrLoadModule("/src/i18n/index.ts");
        store.dispatch({ type: "status/defaults/fulfilled", payload: { is_production: isProduction, raster: {}, vector: {} } });
        store.dispatch(scan.updateROI({
          scan_regions: [{ x_start: 10, x_end: 30, y_start: 10, y_end: 30 }],
          roi_scan_enabled: true,
          scan_zoom: 1,
        }));
        function Harness() {
          const phase = useSelector((state) => state.scan.phase);
          const active = phase === "running" || phase === "stopping";
          return React.createElement(ScanControls, { kind, disabled: active, scanActive: active, zoomDisabled: false });
        }
        await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(Harness))); });
        const root = renderer.root;
        const button = (key) => root.findAllByType("button").find((node) => node.props.title === translate("en", key));
        const zoomInput = () => root.findAll((node) => node.props.ariaLabel === translate("en", "scan.zoom") && node.props.onValueChange)[0];
        await act(async () => {
          await button(kind === "vector" ? "scan.infinite.title.vector" : "scan.infinite.title").props.onClick();
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

        // One stream, and it scans the ROI itself: no full-frame region and no
        // full-frame warm-up pass followed by a restart.
        assert.equal(sockets.length, 1, "the live scan starts once, directly on the ROI");
        const first = sockets[0].requests[0];
        assert.equal(first.parallel_rois ?? null, null, "no full-frame background region is combined with the ROI");
        assert.ok(first.roi, "the stream is scanning an ROI");
        const width = first.roi.x_end - first.roi.x_start;
        assert.ok(width > 0 && width < 16383, "the ROI is not the full frame");

        // The service accepts geometry updates once data flows.
        await act(async () => { sockets[0].onmessage?.({ data: new Uint16Array(4).buffer }); });
        await act(async () => { await zoomInput().props.onValueChange("2"); });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
        assert.equal(store.getState().scan.roi.scan_zoom, 2, "the Zoom value is applied");
        const updates = sockets.flatMap((socket) => socket.requests).filter((request) => request.event === "update_geometry");
        const restarted = sockets.length > 1 ? sockets.at(-1).requests[0] : null;
        const zoomedROI = updates.at(-1)?.geometry?.roi ?? restarted?.roi ?? null;
        assert.ok(zoomedROI, "the running scan received the zoomed ROI");
        assert.ok(zoomedROI.x_end - zoomedROI.x_start < width, "Zoom narrows the area scanned");
        assert.equal((updates.at(-1)?.geometry?.parallel_rois ?? restarted?.parallel_rois ?? null), null);

        await act(async () => { button("scan.stop.title").props.onClick(); });
      } finally {
        if (renderer) await act(async () => { renderer.unmount(); });
        await vite.close();
        Object.assign(globalThis, originals);
      }
    });
  }
}
