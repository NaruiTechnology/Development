import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("one-time View shows a message pane with chunk progress while queued and scanning", async () => {
  globalThis.window = {location:{hostname:"x",port:"",protocol:"http:",host:"x"},localStorage:{getItem:()=>null,setItem(){}},
    addEventListener(){},removeEventListener(){},setTimeout,clearTimeout,setInterval,clearInterval};
  const vite = await createServer({server:{middlewareMode:true,watch:null,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});
  try {
    const {store} = await vite.ssrLoadModule("/src/store/index.ts");
    const {ExposureLatticeMessage} = await vite.ssrLoadModule("/src/components/ExposureLatticeOverlay.tsx");
    const x = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    let r;
    await act(async () => { r = create(React.createElement(Provider, {store}, React.createElement(ExposureLatticeMessage))); });
    const text = () => JSON.stringify(r.toJSON());
    const pane = () => r.root.findAll(n => typeof n.props.className === "string" && n.props.className.includes("exposure-lattice-message--view"));
    assert.equal(pane().length, 0, "no pane while idle");
    await act(async () => { store.dispatch(x.exposureViewChanged({phase: "queued"})); });
    assert.equal(pane().length > 0, true, "queued View is announced");
    await act(async () => { store.dispatch(x.exposureViewChanged({phase: "scanning"})); store.dispatch(x.exposureViewExpectedSamples(1000)); });
    assert.match(text(), /1,000/, "waiting for the first chunk reports the expected samples");
    await act(async () => { store.dispatch(x.exposureViewSamplesReceived(400)); });
    assert.match(text(), /400/); assert.match(text(), /1,000/);
    await act(async () => { store.dispatch(x.exposureViewSamplesReceived(600)); });
    assert.match(text(), /1,000/);
    await act(async () => { store.dispatch(x.exposureViewChanged({phase: "completed"})); });
    assert.equal(pane().length, 0, "completed View is drawn on the canvas, no pane");
    await act(async () => { store.dispatch(x.exposureViewChanged({phase: "error", error: "boom"})); });
    assert.match(text(), /boom/);
  } finally { await vite.close(); }
});
