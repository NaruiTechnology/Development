import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {Provider} from "react-redux";
import {act,create} from "react-test-renderer";
import {createServer} from "vite";

test("expanded editing card moves first without changing catalogue/execution order or losing card state",async()=>{
 const originalWindow=globalThis.window;
 globalThis.window={location:{hostname:"example.test",port:"",protocol:"http:",host:"example.test"},localStorage:{getItem:()=>null,setItem(){}},setInterval,clearInterval};
 const vite=await createServer({server:{middlewareMode:true,watch:null,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});let renderer;
 try {
  const {store}=await vite.ssrLoadModule("/src/store/index.ts");
  const actions=await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const {ProcessingPatternCards}=await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
  const {processingScanRegions}=await vite.ssrLoadModule("/src/lib/processingScanRegions.ts");
  const specs=["box","circle","polygon"].map(key=>({key,caption:key,model:"SolidBoxModel",roi:"rect",icon:"patternSolidBox",parameters:[]}));
  store.dispatch(actions.fetchProcessingPatterns.fulfilled({patterns:specs},"test"));
  for(const key of ["box","circle","polygon"])store.dispatch(actions.setPatternRoi({key,roi:{x_start:1,x_end:4,y_start:2,y_end:5}}));
  const render=disabled=>React.createElement(Provider,{store},React.createElement(ProcessingPatternCards,{disabled}));
  await act(async()=>{renderer=create(render(false));});
  const order=()=>renderer.root.findAllByType("div").filter(n=>n.props["data-pattern"]).map(n=>n.props["data-pattern"]);
  const card=key=>renderer.root.findByProps({"data-pattern":key});
  const toggle=async key=>act(async()=>card(key).findByProps({className:"card__collapse-btn"}).props.onClick());
  const baseline=["box","circle","polygon"];
  assert.deepEqual(order(),baseline);
  await act(async()=>store.dispatch(actions.selectPattern("polygon")));
  assert.deepEqual(order(),["polygon","box","circle"],"canvas/tool selection with a drawn ROI promotes its expanded card");
  assert.equal(card("polygon").findByProps({className:"pattern-card__body"}).props.hidden,false);
  await toggle("polygon");
  assert.deepEqual(order(),baseline,"collapsing restores catalogue order");
  await toggle("circle");
  assert.deepEqual(order(),["circle","box","polygon"],"manual expansion promotes the card");
  assert.equal(card("polygon").findByProps({className:"pattern-card__body"}).props.hidden,true);
  const state=store.getState().processing;
  assert.deepEqual(state.specs.map(s=>s.key),baseline);
  assert.deepEqual(processingScanRegions(state.specs,state.instances,{x_origin:0,x_end:100,y_origin:0,y_end:100}).keys,baseline);
  await act(async()=>renderer.update(render(true)));
  assert.deepEqual(order(),baseline,"execution retains the catalogue presentation order");
  await act(async()=>renderer.update(render(false)));
  assert.deepEqual(order(),["circle","box","polygon"]);
  assert.equal(card("circle").findByProps({className:"pattern-card__body"}).props.hidden,false,"reordering preserves expanded card state");
  await act(async()=>store.dispatch(actions.clearPatternRoi("circle")));
  assert.deepEqual(order(),baseline,"clearing the expanded shape restores order");
 }finally{if(renderer)await act(async()=>renderer.unmount());await vite.close();globalThis.window=originalWindow;}
});
