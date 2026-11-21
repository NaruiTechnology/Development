import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("LiveView uses exposure lattice coverage and levels independently of regular scan images and UI shape", async () => {
  const keys = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  globalThis.window = { location: { hostname: "x", port: "", protocol: "http:", host: "x" },
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const calls = [];
  let renderedImage;
  const context = {
    clearRect() {}, save() { calls.push(["save"]); }, beginPath() {},
    rect(...args) { calls.push(["rect", ...args]); }, clip() { calls.push(["clip"]); },
    ellipse(...args) { calls.push(["ellipse", ...args]); },
    drawImage(_image, ...args) { calls.push(["draw", ...args]); }, restore() { calls.push(["restore"]); },
  };
  globalThis.document = { createElement: () => ({ getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData(image) { renderedImage=image.data.slice(); },
  }) }) };
  let renderer;
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  try {
    const { store: defaults } = await vite.ssrLoadModule("/src/store/index.ts");
    const { LiveViewCanvas } = await vite.ssrLoadModule("/src/components/LiveViewCanvas.tsx");
    const state = defaults.getState();
    const initial = { ...state,
      scan: { ...state.scan, roi: { ...state.scan.roi, x_origin: 0, x_end: 16383, y_origin: 0, y_end: 16383 } },
      exposure: { ...state.exposure, viewZoom: 2 },
      processing: { ...state.processing, activeKey: "circle", instances: {
        circle: { roi: { x_start: 100, x_end: 200, y_start: 100, y_end: 200 } },
      } },
      image: { ...state.image, millingFrame: { key: "circle:1", pass: 1, resolution: 16,
        lattice: { shape: {kind:"ellipse",cx:8000,cy:8000,rx:2000,ry:3000},pitch_x:250,pitch_y:375,axis:"x",dwell:0,passes:1 },
        projection: {x_origin:0,x_end:16383,y_origin:0,y_end:16383,scanGeometry:null},
        bounds: { x_start: 6000, x_end: 10000, y_start: 5000, y_end: 11000 },
        pixels: Uint16Array.from({length:256},(_,i)=>100+i), valid: new Uint8Array(256).fill(1), changePercent: new Float32Array(256).fill(-1) } },
    };
    const store = configureStore({ middleware:()=>[], reducer: (current=initial,action) => action.type==="test/changeScan" ? {
      ...current, scan: {...current.scan,kind:"vector",raster:{...current.scan.raster,resolution:2048},vector:{...current.scan.vector,vector_resolution:128}},
      image: {...current.image,frame:new Uint16Array(4096).fill(65532),vectorImage:new Uint16Array(4096).fill(0)},
    } : current });
    await act(async () => {
      renderer = create(React.createElement(Provider, { store }, React.createElement(LiveViewCanvas, {
        contrastHost: null, toolsHost: null, pointerWorld: () => ({ x: 0, y: 0 }),
      })), { createNodeMock: node => node.type === "canvas" ? { getContext: () => context } : null });
    });
    const overlay = renderer.root.findByProps({ "aria-label": "Draggable LiveView rectangle" }).props.style;
    const clip = calls.find(call => call[0] === "rect").slice(1);
    const expected = [overlay.left, overlay.top, overlay.width, overlay.height].map(value => parseFloat(value) * 6.4);
    clip.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8));
    assert.equal(calls.some(call=>call[0]==="ellipse"),false,"no mask inferred from the editable UI shape");
    assert.equal(renderedImage[3],0,"outside lattice coverage stays transparent");
    assert.equal(renderedImage[(8*16+8)*4+3],255,"measured lattice interior is visible");
    assert.ok(renderedImage.some((v,i)=>i%4===0&&v>100),"first-pass contrast uses detector samples, not the background image levels");
    const draw = calls.find(call => call[0] === "draw").slice(1);
    assert.deepEqual(draw, clip, "the complete detector image fits the window even when detector bounds exceed the UI circle");
    const before=renderedImage.slice();
    await act(async()=>{store.dispatch({type:"test/changeScan"});});
    assert.deepEqual(renderedImage,before,"regular scan pixels, type and resolution cannot change LiveView content");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
