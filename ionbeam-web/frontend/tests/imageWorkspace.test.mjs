import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider, useSelector } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("SCAN and Processing retain independent images, target gray, and range filters", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {} },
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    addEventListener() {}, removeEventListener() {} };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const { useWorkspaceState } = await vite.ssrLoadModule("/src/hooks/useWorkspaceState.ts");
    let controls;
    function Controls() {
      const workspace = useSelector(s => s.scan.imageWorkspace);
      const [range, setRange] = useWorkspaceState(workspace, [0, 255]);
      const [enabled, setEnabled] = useWorkspaceState(workspace, false);
      const [skip, setSkip] = useWorkspaceState(workspace, null);
      controls = { range, setRange, enabled, setEnabled, skip, setSkip };
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(Controls))); });
    const state = () => store.getState().scan;
    const switchTo = async workspace => act(async () => { store.dispatch(scan.setImageWorkspace(workspace)); });
    await act(async () => {
      store.dispatch(scan.updateROI({ imageName: "scan.png", imageDataUrl: "data:scan", imageKind: "file",
        imageBounds: { x_start: 1, x_end: 3, y_start: 2, y_end: 4 },
        scanImageDataUrl: "data:scan-result", roiScanResultUrl: "data:scan-feedback" }));
      store.dispatch(scan.setSelectedTargetGray({ value: 42, point: { x: 2, y: 3 } }));
      store.dispatch(scan.setROIGrayScaleSelection({ selection: [20, 80], isSkipped: true }));
      controls.setRange([20, 80]); controls.setEnabled(true); controls.setSkip(true);
    });
    const savedImage = { ...state().roi };
    const delayedScanUpdate = controls.setRange;
    await switchTo("processing");
    assert.equal(state().roi.imageDataUrl, null, "Processing starts without the SCAN image");
    assert.equal(state().roi.scanImageDataUrl, null);
    assert.equal(state().roi.roiScanResultUrl, null);
    assert.equal(state().selectedTargetGray, null);
    assert.equal(state().selectedTargetGrayPoint, null);
    assert.equal(state().roiGrayScaleSelection, null);
    assert.deepEqual(controls.range, [0, 255]);
    assert.equal(controls.enabled, false);
    assert.equal(controls.skip, null);
    await act(async () => {
      store.dispatch(scan.updateROI({ imageName: "processing.png", imageDataUrl: "data:processing", imageKind: "file" }));
      store.dispatch(scan.setSelectedTargetGray({ value: 180, point: { x: 9, y: 8 } }));
      store.dispatch(scan.setROIGrayScaleSelection({ selection: [150, 220], isSkipped: false }));
      controls.setRange([150, 220]); controls.setEnabled(true); controls.setSkip(false);
      delayedScanUpdate([25, 85]);
    });
    assert.deepEqual(controls.range, [150, 220], "pending SCAN edits cannot modify Processing");
    await switchTo("scan");
    assert.deepEqual(state().roi, savedImage);
    assert.equal(state().selectedTargetGray, 42);
    assert.deepEqual(state().selectedTargetGrayPoint, { x: 2, y: 3 });
    assert.deepEqual(state().roiGrayScaleSelection, [20, 80]);
    assert.equal(state().roiGrayScaleSkipped, true);
    assert.deepEqual(controls.range, [25, 85]);
    assert.equal(controls.enabled, true);
    assert.equal(controls.skip, true);
    await act(async () => {
      store.dispatch(scan.clearROIImage());
      store.dispatch(scan.setSelectedTargetGray({ value: null }));
      store.dispatch(scan.setROIGrayScaleSelection({ selection: null }));
      controls.setEnabled(false);
    });
    await switchTo("processing");
    assert.equal(state().roi.imageDataUrl, "data:processing");
    assert.equal(state().selectedTargetGray, 180);
    assert.deepEqual(state().selectedTargetGrayPoint, { x: 9, y: 8 });
    assert.deepEqual(state().roiGrayScaleSelection, [150, 220]);
    assert.equal(state().roiGrayScaleSkipped, false);
    assert.deepEqual(controls.range, [150, 220]);
    assert.equal(controls.enabled, true);
    assert.equal(controls.skip, false);
    store.dispatch(scan.streamStarted());
    await switchTo("scan");
    assert.equal(state().phase, "running", "navigation preserves acquisition state");
    assert.equal(state().roi.imageDataUrl, null, "clearing SCAN stays local and survives navigation");
    assert.equal(state().selectedTargetGray, null);
    assert.equal(controls.enabled, false);
    await switchTo("scan");
    assert.equal(state().roi.imageDataUrl, null, "selecting the same workspace is a no-op");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    await vite.close();
    globalThis.window = originalWindow;
  }
});
