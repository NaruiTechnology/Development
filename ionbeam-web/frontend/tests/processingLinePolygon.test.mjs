import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";
import { MODEL_REGISTRY, lineRoi, lineEndpoints, patternBounds, patternAvgGray } from "../.test-dist/lib/processingPatterns.js";
import { processingScanRegions } from "../.test-dist/lib/processingScanRegions.js";
import { workflowPoints, DEFAULT_WORKFLOW } from "../.test-dist/lib/processingWorkflows.js";

const catalogue = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url)));
const specs = ["line", "polygon"].map(key => ({ key, ...catalogue.Patterns.find(p => p[key])[key],
  parameters: Object.entries(catalogue.Patterns.find(p => p[key])[key].parameters).map(([name, p]) => ({name, ...p})) }));

test("line masks have world-space width in every direction and usable acquisition bounds", () => {
  for (const [a, b] of [[[0, 0], [10, 0]], [[0, 10], [0, 0]], [[0, 0], [6, 8]], [[6, 8], [0, 0]]]) {
    const r = MODEL_REGISTRY.LineModel.validateRoi(lineRoi(a, b, 2));
    assert.deepEqual(lineEndpoints(r), [a, b]);
    assert.ok(Math.abs(MODEL_REGISTRY.LineModel.area(r) - 20) < 1e-8);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    assert.ok(MODEL_REGISTRY.LineModel.contains(r, ...mid));
    assert.equal(MODEL_REGISTRY.LineModel.contains(r, 50, 50), false);
    const plan = processingScanRegions([specs[0]], { line: {roi: r} }, {x_origin: -10, x_end: 100, y_origin: -10, y_end: 100});
    assert.equal(plan.regions.length, 1);
    assert.deepEqual(plan.regions[0], patternBounds(r));
  }
  assert.throws(() => lineRoi([1, 1], [1, 1], 2));
  assert.throws(() => lineRoi([0, 0], [1, 1], 0));
  assert.throws(() => lineRoi([0, 0], [Infinity, 1], 1));
});

test("four-click polygons reject degeneracy and crossing edges, support concavity and boundaries", () => {
  const m = MODEL_REGISTRY.PolygonModel;
  const r = m.validateRoi({points: [[0, 0], [4, 0], [1, 1], [0, 4]]});
  assert.equal(m.area(r), 4);
  assert.ok(m.contains(r, 0.5, 0.5));
  assert.ok(m.contains(r, 0, 0));
  assert.equal(m.contains(r, 3, 3), false);
  for (const points of [[[0,0],[1,0],[1,1]], [[0,0],[4,4],[0,3],[4,0]], [[0,0],[1,1],[2,2],[3,3]]]) {
    assert.throws(() => m.validateRoi({points}));
  }
});

test("line and polygon geometry reaches workflow blanking and AvgGray without filling the bounding box", () => {
  const field = {x_start: 0, x_end: 10, y_start: 0, y_end: 10};
  const frame = new Uint16Array(121).fill(100 << 8);
  const shapes = [lineRoi([1,1], [9,9], 2), {points: [[0,0], [10,0], [3,3], [0,10]]}];
  for (const [i, shape] of shapes.entries()) {
    const model = MODEL_REGISTRY[specs[i].model];
    const [step] = workflowPoints(specs[i], shape, field, field, frame, 11, DEFAULT_WORKFLOW, [], 2, "horizontal_sawtooth");
    assert.ok(step.spot > 0 && step.spot < 121);
    step.points.forEach((p, j) => {
      const index = step.pointPixelIndices[j];
      assert.equal(!p[3], model.contains(shape, index % 11, Math.floor(index / 11)));
    });
    assert.equal(patternAvgGray(shape, model, 11, 11, {x_origin:0, x_end:10, y_origin:0, y_end:10}, () => 100), 100);
  }
});

test("Line draws on release; Polygon commits on its fourth click; cancel, edit, width, undo and clear work", async () => {
  const originalWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {location: {hostname:"example.test", port:"", protocol:"http:", host:"example.test"},
    localStorage: {getItem:()=>null, setItem(){}}, addEventListener:(k,f)=>listeners.set(k,f), removeEventListener:k=>listeners.delete(k)};
  const vite = await createServer({server:{middlewareMode:true, watch:null, ws:false}, optimizeDeps:{noDiscovery:true, include:[]}, appType:"custom"});
  let renderer;
  try {
    const {store} = await vite.ssrLoadModule("/src/store/index.ts");
    const actions = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const {PatternOverlay} = await vite.ssrLoadModule("/src/components/PatternOverlay.tsx");
    const {ProcessingPatternsPanel, ProcessingPatternCards} = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const {updateROI} = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    store.dispatch(actions.fetchProcessingPatterns.fulfilled({patterns:specs}, "test"));
    store.dispatch(updateROI({x_origin:0, x_end:100, y_origin:0, y_end:100}));
    const api = {pointFromClient:(x,y)=>({x,y}), toWorld:p=>({x:p.x/2, y:p.y/2}), sampleGrayAtClient:()=>null};
    await act(async()=>{renderer=create(React.createElement(Provider,{store},React.createElement(React.Fragment,null,
      React.createElement(ProcessingPatternsPanel,{disabled:false}), React.createElement(ProcessingPatternCards,{disabled:false}),
      React.createElement(PatternOverlay,{disabled:false,api}))));});
    const overlay=()=>renderer.root.findByProps({"data-testid":"pattern-overlay"});
    const event=(x,y,button=0,target)=>({clientX:x,clientY:y,button,pointerId:1,target,preventDefault(){},currentTarget:{setPointerCapture(){}}});
    const pointer=async(name,e)=>act(async()=>overlay().props[name](e));
    const dispatch=async a=>act(async()=>store.dispatch(a));
    const roi=key=>store.getState().processing.instances[key].roi;
    await dispatch(actions.selectPattern("line"));
    await pointer("onPointerDown",event(20,20));
    await pointer("onPointerMove",event(80,20));
    assert.equal(roi("line"),null);
    await pointer("onPointerUp",event(100,20));
    assert.deepEqual(lineEndpoints(roi("line")),[[10,10],[50,10]]);
    assert.equal(store.getState().processing.instances.line.enabled,true);
    await dispatch(actions.setPatternParameter({key:"line",name:"lineWidth",value:2}));
    assert.equal(MODEL_REGISTRY.LineModel.area(roi("line")),80);
    await dispatch(actions.undoPatternRoi());
    assert.equal(store.getState().processing.instances.line.parameters.lineWidth,0.5);
    const saved=roi("line");
    const target={closest:selector=>selector === "[data-pattern-key]" ? {getAttribute:()=>"line"} : null,getAttribute:()=>null};
    await pointer("onPointerDown",event(20,20,0,target));
    await pointer("onPointerUp",event(40,40));
    assert.deepEqual(lineEndpoints(roi("line")),[[20,20],[60,20]],"line can move without changing width");
    await dispatch(actions.undoPatternRoi());
    assert.deepEqual(roi("line"),saved);
    const handle={closest:selector=>selector === "[data-pattern-key]" ? {getAttribute:()=>"line"} : null,
      getAttribute:name=>name === "data-pattern-resize" ? "se" : null};
    await pointer("onPointerDown",event(100,20,0,handle));
    await pointer("onPointerUp",event(140,60));
    assert.ok(MODEL_REGISTRY.LineModel.area(roi("line")) > MODEL_REGISTRY.LineModel.area(saved));
    const pts=roi("line").points;
    assert.ok(Math.abs(Math.hypot(pts[0][0]-pts[3][0],pts[0][1]-pts[3][1])-0.5)<1e-8,"resize preserves configured width");
    await dispatch(actions.undoPatternRoi());
    assert.deepEqual(roi("line"),saved);
    await pointer("onPointerDown",event(40,40));
    await pointer("onPointerMove",event(100,100));
    await act(async()=>listeners.get("keydown")({key:"Escape"}));
    await pointer("onPointerUp",event(100,100));
    assert.deepEqual(roi("line"),saved);
    await dispatch(actions.selectPattern("polygon"));
    const click=async(x,y)=>{await pointer("onPointerDown",event(x,y));await pointer("onPointerUp",event(x,y));};
    await click(20,20);await click(120,20);await click(120,120);
    assert.equal(roi("polygon"),null);
    await pointer("onPointerLeave",{});
    await pointer("onPointerMove",event(20,120));
    await click(20,120);
    assert.deepEqual(roi("polygon"),{points:[[10,10],[60,10],[60,60],[10,60]]});
    assert.equal(store.getState().processing.instances.polygon.enabled,true);
    const savedPolygon=roi("polygon");
    await click(40,40);await click(80,40);
    await pointer("onPointerDown",event(80,80,2));
    assert.deepEqual(roi("polygon"),savedPolygon);
    await dispatch(actions.clearPatternRoi("polygon"));
    assert.equal(roi("polygon"),null);
    assert.equal(store.getState().processing.instances.polygon.enabled,false);
    await dispatch(actions.undoPatternRoi());
    assert.deepEqual(roi("polygon"),savedPolygon);
  } finally {
    if(renderer) await act(async()=>renderer.unmount());
    await vite.close();globalThis.window=originalWindow;
  }
});
