import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import React from "react";
import {Provider} from "react-redux";
import {act,create} from "react-test-renderer";
import {createServer} from "vite";
const catalogue=JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url)));

test("Patterns help opens the complete source table and computes only supported spot references",async()=>{
 const originals=Object.fromEntries(["window","document","requestAnimationFrame"].map(k=>[k,globalThis[k]]));
 const listeners=new Map();
 globalThis.window={location:{hostname:"example.test",port:"",protocol:"http:",host:"example.test"},localStorage:{getItem:()=>null,setItem(){}},setTimeout,clearTimeout};
 globalThis.document={body:{style:{overflow:"auto"}},addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
 globalThis.requestAnimationFrame=fn=>fn();
 const vite=await createServer({server:{middlewareMode:true,watch:null,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});let renderer;
 try {
  const {store}=await vite.ssrLoadModule("/src/store/index.ts");
  const actions=await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const {ProcessingPatternsHelp}=await vite.ssrLoadModule("/src/components/ProcessingPatternsHelp.tsx");
  store.dispatch(actions.fetchProcessingPatterns.fulfilled({patterns:[],lensLookup:catalogue.LensLookup},"test"));
  await act(async()=>{renderer=create(React.createElement(Provider,{store},React.createElement(ProcessingPatternsHelp)),{createNodeMock:()=>({focus(){}})});});
  const trigger=()=>renderer.root.findByProps({className:"help-btn"});
  await act(async()=>trigger().props.onClick({stopPropagation(){},preventDefault(){}}));
  assert.equal(renderer.root.findAllByProps({role:"dialog"}).length,1);
  assert.equal(renderer.root.findAllByType("tbody")[0].findAllByType("tr").length,11);
  const row=n=>renderer.root.findByProps({"data-source-row":n}).findAllByType("td");
  assert.equal(row(2)[4].children.join(""),"<1");assert.equal(row(9)[5].children.join(""),"5.82*");assert.equal(row(12)[1].children.join(""),"—");
  assert.equal(renderer.root.findAllByType("li").length,6);
  const result=()=>renderer.root.findByProps({"aria-label":"Spot size"}).children.join("");
  assert.equal(result(),"35.00 nm (0.0350 µm)");
  const input=()=>renderer.root.findAllByType("input").find(n=>n.props["aria-label"]==="Beam current (pA)");
  await act(async()=>input().props.onChange({target:{value:"250"}}));
  assert.equal(result(),"—","non-reference currents need explicit interpolation");
  const interpolate=()=>renderer.root.findAllByType("input").find(n=>n.props.type==="checkbox");
  await act(async()=>interpolate().props.onChange({target:{checked:true}}));
  assert.equal(result(),"45.00 nm (0.0450 µm)");
  await act(async()=>renderer.root.findByType("select").props.onChange({target:{value:"10"}}));
  assert.equal(result(),"300.00 nm (0.3000 µm)");
  await act(async()=>input().props.onChange({target:{value:"150"}}));
  assert.equal(result(),"—","the 30kV anchor is not reused for 10kV");
  await act(async()=>listeners.get("keydown")({key:"Escape",stopPropagation(){}}));
  assert.equal(renderer.root.findAllByProps({role:"dialog"}).length,0);
  assert.equal(document.body.style.overflow,"auto");
 } finally {
  if(renderer)await act(async()=>renderer.unmount());await vite.close();
  for(const [key,value] of Object.entries(originals))globalThis[key]=value;
 }
});
