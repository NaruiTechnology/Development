import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import React from "react";
import {Provider} from "react-redux";
import {act,create} from "react-test-renderer";
import {createServer} from "vite";
import {patternGeometryValues,editPatternGeometry,patternCenterOffset,formatPatternTime,patternParameterError,patternDwellTicks,lineRoi} from "../.test-dist/lib/processingPatterns.js";

const json=JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url)));
const specs=json.Patterns.filter(p=>!Object.values(p)[0].skip).map(p=>{const [key,b]=Object.entries(p)[0];return {key,...b,
 parameters:Object.entries(b.parameters).map(([name,s])=>({name,...s})),readouts:Object.entries(b.readouts).map(([name,s])=>({name,...s}))};});

test("every active pattern defines recipe spinners and runtime labels in the catalogue",()=>{
 for(const spec of specs){
  for(const name of ["depth","dwell","overlap"]) assert.ok(spec.parameters.some(p=>p.name===name),`${spec.key}: ${name}`);
  assert.deepEqual(spec.readouts.map(p=>p.source),["elapsed","centerX","centerY"]);
 }
});

test("geometry edits preserve centres and validate ring ordering",()=>{
 const ring={cx:10,cy:20,r_inner:2,r_outer:5};
 const r=editPatternGeometry({model:"RingModel"},ring,"rOuter",8);
 assert.deepEqual(r,{...ring,r_outer:8});
 assert.throws(()=>editPatternGeometry({model:"RingModel"},r,"rInner",8));
 const rect={x_start:10,x_end:20,y_start:30,y_end:40};
 assert.deepEqual(editPatternGeometry({model:"SolidBoxModel"},rect,"width",20),{x_start:5,x_end:25,y_start:30,y_end:40});
 const poly={points:[[0,0],[4,0],[3,4],[0,3]]};
 assert.equal(patternGeometryValues({model:"PolygonModel"},editPatternGeometry({model:"PolygonModel"},poly,"height",8)).height,8);
 const line=lineRoi([0,0],[3,4],2);
 const longer=editPatternGeometry({model:"LineModel"},line,"length",10);
 const v=patternGeometryValues({model:"LineModel"},longer);
 assert.ok(Math.abs(v.length-10)<1e-9 && Math.abs(v.lineWidth-2)<1e-9);
});

test("validation, dwell conversion, centre offsets and runtime formatting",()=>{
 const ring=specs.find(s=>s.key==="ring");const outer=ring.parameters.find(p=>p.name==="rOuter");
 assert.ok(patternParameterError(outer,1,ring,{cx:0,cy:0,r_inner:2,r_outer:5}));
 const overlap=ring.parameters.find(p=>p.name==="overlap");
 for(const value of ["",NaN,Infinity,-1,100]) assert.ok(patternParameterError(overlap,value));
 assert.equal(patternParameterError(overlap,99.9),null);
 assert.equal(patternDwellTicks(1,0),7);assert.equal(patternDwellTicks(0.125,9),0);assert.equal(patternDwellTicks(8192,0),65535);
 assert.equal(patternDwellTicks(undefined,3),3);
 assert.deepEqual(patternCenterOffset({cx:30,cy:40,radius:5},{x_origin:0,x_end:100,y_origin:0,y_end:200}),{x:-20,y:-60});
 assert.equal(patternCenterOffset(null,{x_origin:0,x_end:100,y_origin:0,y_end:200}),null);
 assert.equal(formatPatternTime(3661000),"01:01:01");assert.equal(formatPatternTime(500*3600000),"500:00:00");
});

test("Ring spinners update geometry; drawing/undo sync values; runtime outputs use full-image centre and frozen elapsed time",async()=>{
 const originalWindow=globalThis.window;
 globalThis.window={location:{hostname:"example.test",port:"",protocol:"http:",host:"example.test"},localStorage:{getItem:()=>null,setItem(){}},setInterval,clearInterval};
 const vite=await createServer({server:{middlewareMode:true,watch:null,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});let renderer;
 try{
  const {store}=await vite.ssrLoadModule("/src/store/index.ts");
  const actions=await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const {updateROI}=await vite.ssrLoadModule("/src/store/scanSlice.ts");
  const {ProcessingPatternCards}=await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
  store.dispatch(actions.fetchProcessingPatterns.fulfilled({patterns:specs},"test"));
  store.dispatch(updateROI({x_origin:0,x_end:100,y_origin:0,y_end:200}));
  store.dispatch(actions.selectPattern("ring"));store.dispatch(actions.setPatternRoi({key:"ring",roi:{cx:30,cy:40,r_inner:2,r_outer:5}}));
  await act(async()=>{renderer=create(React.createElement(Provider,{store},React.createElement(ProcessingPatternCards,{disabled:false})));});
  const card=()=>renderer.root.findByProps({"data-pattern":"ring"});
  const input=label=>card().findAllByType("input").find(n=>n.props["aria-label"]===label);
  assert.equal(input("Rin (μm)").props.value,"2.00");assert.equal(input("Rout (μm)").props.value,"5.00");
  await act(async()=>store.dispatch(actions.setPatternRoi({key:"ring",roi:{cx:30,cy:40,r_inner:2.123456,r_outer:5}})));
  assert.equal(input("Rin (μm)").props.value,"2.12","idle fields show two decimals");
  assert.equal(store.getState().processing.instances.ring.roi.r_inner,2.123456,"display rounding preserves geometry precision");
  await act(async()=>input("Rin (μm)").props.onFocus());
  assert.equal(input("Rin (μm)").props.value,"2.123456","editing retains the exact value");
  await act(async()=>input("Rin (μm)").props.onBlur());
  assert.equal(input("Rin (μm)").props.value,"2.12");
  await act(async()=>store.dispatch(actions.setPatternRoi({key:"ring",roi:{cx:30,cy:40,r_inner:2,r_outer:5}})));
  const output=name=>card().findByProps({"data-readout":name}).children.join("");
  assert.equal(output("centerX"),"-20.00");assert.equal(output("centerY"),"-60.00");assert.equal(output("time"),"—");
  await act(async()=>input("Rout (μm)").props.onChange({target:{value:"8"}}));
  assert.equal(store.getState().processing.instances.ring.roi.r_outer,8);
  await act(async()=>input("Rin (μm)").props.onChange({target:{value:"9"}}));
  assert.equal(store.getState().processing.instances.ring.roi.r_inner,2);assert.equal(input("Rin (μm)").props["aria-invalid"],"true");
  await act(async()=>store.dispatch(actions.undoPatternRoi()));
  assert.equal(store.getState().processing.instances.ring.parameters.rOuter,5);
  await act(async()=>store.dispatch(actions.setWorkflowProgress([{id:"ring:0",pattern:"Ring",caption:"Step",action:"Scan",status:"completed",threshold:null,spot:0,total:0,startedAt:1000,finishedAt:3662000}])));
  assert.equal(output("time"),"01:01:01");
  await act(async()=>store.dispatch(updateROI({scan_zoom:4,selection:{x_start:5,x_end:20,y_start:5,y_end:20}})));
  assert.equal(output("centerX"),"-20.00");assert.equal(output("time"),"01:01:01");
  await act(async()=>store.dispatch(updateROI({imageDataUrl:"test-image",imageBounds:{x_start:0,x_end:200,y_start:0,y_end:100}})));
  assert.equal(output("centerX"),"-70.00");assert.equal(output("centerY"),"-10.00");
  assert.equal(card().findAllByType("output").length,3,"derived fields are labels, not editable inputs");
  await act(async()=>store.dispatch(actions.clearPatternRoi("ring")));
  assert.equal(output("centerX"),"—");
 }finally{if(renderer)await act(async()=>renderer.unmount());await vite.close();globalThis.window=originalWindow;}
});
