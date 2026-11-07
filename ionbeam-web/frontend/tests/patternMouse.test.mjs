import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("pattern mouse selects, moves within bounds, resizes all corners, cancels and removes", async () => {
  const oldWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const { PatternOverlay } = await vite.ssrLoadModule("/src/components/PatternOverlay.tsx");
    const { updateROI } = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const actions = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    store.dispatch(actions.fetchProcessingPatterns.fulfilled({ patterns: [
      { key: "box", caption: "Box", model: "SolidBoxModel", icon: "patternSolidBox", roi: "rect", parameters: [] },
    ] }, "test"));
    store.dispatch(updateROI({ x_origin: 0, x_end: 640, y_origin: 0, y_end: 640 }));
    const initial = { x_start: 100, x_end: 200, y_start: 100, y_end: 200 };
    store.dispatch(actions.setPatternRoi({ key: "box", roi: initial }));
    const api = { pointFromClient: (x,y) => ({x,y}), toWorld: p => p };
    await act(async () => { renderer = create(React.createElement(Provider, {store},
      React.createElement(PatternOverlay, {disabled: false, api}))); });
    const overlay = () => renderer.root.findByProps({"data-testid": "pattern-overlay"});
    const shape = { getAttribute: name => name === "data-pattern-key" ? "box" : null };
    const event = (x,y,corner = null) => ({ clientX:x, clientY:y, button:0, pointerId:1,
      preventDefault() {}, stopPropagation() {}, currentTarget: {setPointerCapture() {}},
      target: { closest: selector => selector === "[data-pattern-key]" ? shape : null,
        getAttribute: name => name === "data-pattern-resize" ? corner : null } });
    const pointer = async (name,e) => act(async () => overlay().props[name](e));
    const roi = () => store.getState().processing.instances.box.roi;
    await pointer("onPointerDown", event(150,150));
    assert.equal(store.getState().processing.activeKey, "box");
    assert.equal(renderer.root.findAll(n => n.type === "rect" && n.props["data-pattern-resize"]).length, 4);
    await pointer("onPointerMove", event(900,900));
    assert.deepEqual(roi(), {x_start:540,x_end:640,y_start:540,y_end:640});
    await pointer("onPointerCancel", event(900,900));
    assert.deepEqual(roi(), initial);
    for (const [corner,x,y,expected] of [
      ["nw",80,70,{x_start:80,x_end:200,y_start:70,y_end:200}],
      ["ne",230,70,{x_start:100,x_end:230,y_start:70,y_end:200}],
      ["sw",80,230,{x_start:80,x_end:200,y_start:100,y_end:230}],
      ["se",230,240,{x_start:100,x_end:230,y_start:100,y_end:240}],
    ]) {
      await act(async () => store.dispatch(actions.setPatternRoi({key:"box",roi:initial})));
      await pointer("onPointerDown", event(150,150,corner));
      await pointer("onPointerUp", event(x,y));
      assert.deepEqual(roi(), expected, corner);
    }
    await act(async () => store.dispatch(actions.setPatternRoi({key:"box",roi:initial})));
    await pointer("onPointerDown", {...event(101,101), ctrlKey:true});
    await pointer("onPointerUp", event(80,70));
    assert.deepEqual(roi(), {x_start:80,x_end:200,y_start:70,y_end:200}, "Ctrl near corner resizes");
    await act(async () => store.dispatch(actions.setPatternRoi({key:"box",roi:{x_start:100,x_end:230,y_start:100,y_end:240}})));
    const historyBeforeDrag = store.getState().processing.roiHistory.length;
    await pointer("onPointerDown", event(150,150));
    await pointer("onPointerMove", event(180,180));
    await act(async () => listeners.get("keydown")({key:"Escape"}));
    assert.deepEqual(roi(), {x_start:100,x_end:230,y_start:100,y_end:240});
    assert.equal(store.getState().processing.roiHistory.length, historyBeforeDrag, "cancelled drag adds no history");
    await pointer("onContextMenu", event(150,150));
    const remove = renderer.root.findByProps({className:"canvas-editor__menu-item"});
    await act(async () => remove.props.onClick({stopPropagation(){}}));
    assert.equal(roi(), null);
    assert.equal(store.getState().processing.instances.box.AvgGray, null);
    const undo = target => listeners.get("keydown")({ key:"z", ctrlKey:true, target, preventDefault(){}, stopPropagation(){} });
    await act(async () => undo());
    const restored = {x_start:100,x_end:230,y_start:100,y_end:240};
    assert.deepEqual(roi(), restored, "Ctrl+Z restores removed ROI");
    const history = store.getState().processing.roiHistory.length;
    await pointer("onPointerDown", event(150,150));
    await pointer("onPointerMove", event(160,160));
    await pointer("onPointerMove", event(170,170));
    await pointer("onPointerUp", event(180,180));
    assert.equal(store.getState().processing.roiHistory.length, history + 1, "one undo entry per complete drag");
    await act(async () => undo({closest: () => ({})}));
    assert.notDeepEqual(roi(), restored, "text fields keep native undo");
    await act(async () => undo());
    assert.deepEqual(roi(), restored, "one undo reverts entire drag");
    await act(async () => store.dispatch(actions.clearPatternRoi("box")));
    await act(async () => store.dispatch(actions.setPatternRoi({key:"box",roi:initial})));
    await act(async () => undo());
    assert.equal(roi(), null, "undo drawing restores empty ROI");
    await act(async () => undo());
    assert.deepEqual(roi(), restored, "repeated undo walks earlier edits");

    await act(async () => {
      store.dispatch(actions.fetchProcessingPatterns.fulfilled({patterns:[
        {key:"ring",caption:"Ring",model:"RingModel",icon:"patternRing",roi:"ring",parameters:[]},
      ]}, "ring-test"));
      store.dispatch(actions.selectPattern("ring"));
    });
    const blankEvent = (x,y) => ({...event(x,y), target:{closest:()=>null}});
    const circles = () => renderer.root.findAll(n => n.type === "ellipse" && n.props["data-ring-boundary"]);
    const assertConcentric = () => {
      const [outer,inner] = circles();
      assert.ok(outer && inner, "ring has two circle outlines");
      assert.equal(outer.props.cx, inner.props.cx);
      assert.equal(outer.props.cy, inner.props.cy);
      assert.ok(outer.props.rx > inner.props.rx && inner.props.rx > 0);
      assert.ok(outer.props.ry > inner.props.ry && inner.props.ry > 0);
    };
    await pointer("onPointerDown", blankEvent(300,300));
    await pointer("onPointerMove", blankEvent(400,300));
    assertConcentric();
    await pointer("onPointerUp", blankEvent(400,300));
    assertConcentric();
    assert.deepEqual(store.getState().processing.instances.ring.roi, {cx:300,cy:300,r_inner:50,r_outer:100}, "first drag creates donut immediately");
    const innerEvent = (x,y) => ({...event(x,y), target:{
      closest: selector => selector === "[data-pattern-key]" ? {getAttribute:()=>"ring"} : null,
      getAttribute: name => name === "data-pattern-inner" ? "true" : null,
    }});
    await pointer("onPointerDown", innerEvent(350,300));
    await pointer("onPointerMove", innerEvent(340,300));
    await pointer("onPointerUp", innerEvent(340,300));
    assert.deepEqual(store.getState().processing.instances.ring.roi, {cx:300,cy:300,r_inner:40,r_outer:100}, "inner handle changes only the hole");
    assertConcentric();
    await act(async () => undo());
    assert.deepEqual(store.getState().processing.instances.ring.roi, {cx:300,cy:300,r_inner:50,r_outer:100});
    await pointer("onPointerDown", innerEvent(350,300));
    await pointer("onPointerUp", innerEvent(500,300));
    assertConcentric();
    assert.equal(store.getState().processing.instances.ring.roi.r_inner, 95, "hole cannot collapse the annulus");

  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    globalThis.window = oldWindow;
  }
});
