import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import React from "react";
import {Provider} from "react-redux";
import {act, create} from "react-test-renderer";
import {createServer} from "vite";

test("drawing repeated pattern types creates independent indexed ROI tabs and exposure entries", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {location: {hostname: "x", protocol: "http:", host: "x"},
    localStorage: {getItem: () => null, setItem() {}}, addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval};
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer;
  try {
    const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
    const store = getWorkspaceStore("processing");
    const actions = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const {updateROI} = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const {PatternOverlay} = await vite.ssrLoadModule("/src/components/PatternOverlay.tsx");
    const {ProcessingPatternsPanel, ProcessingPatternCards} = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const {prepareExposureSequence} = await vite.ssrLoadModule("/src/lib/exposureSequence.ts");
    const {exposureViewScanRegions} = await vite.ssrLoadModule("/src/lib/processingScanRegions.ts");
    const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;
    const values = {beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", passes: 2};
    const parameters = Object.entries(values).map(([name, value]) => ({name, label: name,
      type: typeof value === "string" ? "choice" : "float", default: value,
      choices: typeof value === "string" ? ["x", "y"] : []}));
    const catalogue = {patterns: [{key: "box", caption: "Box", model: "SolidBoxModel", icon: "patternSolidBox", roi: "rect", parameters}], lensLookup};
    store.dispatch(actions.fetchProcessingPatterns.fulfilled(catalogue, "multi"));
    store.dispatch(updateROI({x_origin: 0, x_end: 1, y_origin: 0, y_end: 1}));
    store.dispatch(actions.selectPattern("box"));
    const api = {sampleGrayAtClient: () => null, pointFromClient: (x, y) => ({x, y}), toWorld: ({x, y}) => ({x: x / 640, y: y / 640})};
    await act(async () => { renderer = create(React.createElement(Provider, {store},
      React.createElement(PatternOverlay, {disabled: false, api}),
      React.createElement(ProcessingPatternsPanel, {disabled: false}),
      React.createElement(ProcessingPatternCards, {disabled: false}))); });
    const state = () => store.getState().processing;
    const event = (x, y) => ({clientX: x, clientY: y, button: 0, pointerId: 1,
      preventDefault() {}, stopPropagation() {}, currentTarget: {setPointerCapture() {}}, target: {closest: () => null}});
    async function draw(x, y) {
      for (const [name, e] of [["onPointerDown", event(x, y)], ["onPointerMove", event(x + 80, y + 80)], ["onPointerUp", event(x + 80, y + 80)]])
        await act(async () => renderer.root.findByProps({"data-testid": "pattern-overlay"}).props[name](e));
    }
    await draw(20, 20);
    const first = state().instances.box.roi;
    assert.equal(state().instances.box.index, 1);
    assert.equal(renderer.root.findAllByProps({role: "tab"}).length, 0);
    await draw(240, 240);
    const secondKey = state().activeKey;
    assert.notEqual(secondKey, "box");
    assert.deepEqual(state().instances.box.roi, first, "a new drawing preserves the first ROI");
    assert.equal(state().instances[secondKey].typeKey, "box");
    assert.equal(state().instances[secondKey].index, 2);
    assert.deepEqual(renderer.root.findAllByProps({role: "tab"}).map(tab => tab.children.join("")), ["1", "2"]);
    assert.equal(renderer.root.findByProps({className: "pattern-strip"}).findAllByType("button").length, 1,
      "the catalogue toolbar has one icon per pattern type");
    const markers = renderer.root.findAllByProps({className: "pattern-roi-axis-cue"});
    assert.deepEqual(markers.map(marker => marker.findByType("text").children.join("")), ["1 · X", "2 · X"]);
    await act(async () => store.dispatch(actions.setPatternParameter({key: secondKey, name: "passes", value: 3})));
    assert.equal(state().instances.box.parameters.passes, 2);
    assert.equal(state().instances[secondKey].parameters.passes, 3);
    const entries = prepareExposureSequence(state(), store.getState().scan.roi, false);
    assert.deepEqual(entries.map(entry => entry.key), ["box", secondKey]);
    assert.equal(new Set(entries.map(entry => entry.node.id)).size, 2);
    assert.deepEqual(entries.map(entry => entry.request.lattice.passes), [2, 3]);
    assert.equal(exposureViewScanRegions(state().specs, state().instances, store.getState().scan.roi).regions.length, 2);
    await act(async () => renderer.root.findAllByProps({role: "tab"})[0].props.onClick());
    assert.equal(state().activeKey, "box");
    assert.equal(renderer.root.findByProps({role: "tabpanel"}).findByProps({"data-pattern": "box"}).props["aria-label"], "Box - 1");
    await act(async () => store.dispatch(actions.setPatternRoi({key: "box", roi: first})));
    assert.equal(state().specs.length, 2, "editing an ROI does not add an instance");
    await draw(440, 440);
    assert.equal(state().instances[state().activeKey].index, 3);
    await act(async () => store.dispatch(actions.undoPatternRoi()));
    assert.equal(state().specs.length, 2, "undo removes a newly created instance and its tab");
    await act(async () => store.dispatch(actions.fetchProcessingPatterns.fulfilled(catalogue, "reload")));
    assert.equal(state().specs.length, 2, "catalogue reload preserves all instances");
    assert.equal(state().instances[secondKey].parameters.passes, 3);
    assert.deepEqual(state().instances.box.roi, first);
    const beforeInvalid = state().specs.length;
    await act(async () => store.dispatch(actions.createPatternRoi({key: "box", roi: {x_start: 1, x_end: 1, y_start: 0, y_end: 0}})));
    assert.equal(state().specs.length, beforeInvalid, "invalid drawings do not create empty tabs");
    await act(async () => store.dispatch(actions.setPatternEnabled({key: secondKey, enabled: false})));
    assert.deepEqual(prepareExposureSequence(state(), store.getState().scan.roi, false).map(entry => entry.key), ["box"]);
    await act(async () => store.dispatch(actions.clearPatternRoi(secondKey)));
    assert.deepEqual(state().instances.box.roi, first, "removing one ROI leaves its sibling intact");
  } finally {
    await act(async () => renderer?.unmount());
    await vite.close();
    globalThis.window = previousWindow;
  }
});
