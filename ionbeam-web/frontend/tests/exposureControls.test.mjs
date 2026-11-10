import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url))).LensLookup;
test("Patterns header exposure controls default to serial and leave scan state and pixels intact", async()=>{
  const old = {window:globalThis.window, fetch:globalThis.fetch, WebSocket:globalThis.WebSocket};
  globalThis.window={location:{hostname:"example.test",port:"",protocol:"http:",host:"example.test"},
    localStorage:{getItem:()=>null,setItem(){}},addEventListener(){},removeEventListener(){},setTimeout,clearTimeout,setInterval,clearInterval};
  let abortResolve=null, aborts=0;
  globalThis.fetch=async url=>{
    if(String(url).includes("/api/scan/abort")) {aborts++; return new Promise(resolve=>{abortResolve=()=>resolve({ok:true,status:200});});}
    return {ok:true,status:200,json:async()=>({ok:true,registered:true,user:{is_active:true,role:5}})};
  };
  const sockets=[];
  class Socket {
    static OPEN=1; static CONNECTING=0; static CLOSING=2; static CLOSED=3;
    readyState=0; requests=[];
    constructor(){sockets.push(this);queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}});}
    send(data){this.requests.push(JSON.parse(data));}
    close(code=1000){if(this.readyState>=2)return;this.readyState=2;queueMicrotask(()=>{this.readyState=3;this.onclose?.({code});});}
    done(){this.onmessage?.({data:JSON.stringify({event:"done"})});this.close();}
    samples(count){this.onmessage?.({data:new ArrayBuffer(count*2)});}
  }
  globalThis.WebSocket=Socket;
  const vite=await createServer({server:{middlewareMode:true,watch:null,ws:false}, optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});
  let renderer;
  try {
    const {store}=await vite.ssrLoadModule("/src/store/index.ts");
    const {ExposureControls}=await vite.ssrLoadModule("/src/components/ExposureControls.tsx");
    const processing=await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const scan=await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const image=await vite.ssrLoadModule("/src/store/imageSlice.ts");
    const {claimWorkspaceRun,otherWorkspaceBusy}=await vite.ssrLoadModule("/src/hooks/useScanWorkspace.ts");
    store.dispatch({type:"status/defaults/fulfilled",payload:{is_production:false,raster:{},vector:{}}});
    const values={beamCurrent:150,dwell:1,overlap:50,axis:"x",steps:5,depth:1,passes:2};
    const parameters=Object.entries(values).map(([name,value])=>({name,label:name,type:typeof value==="string"?"choice":"float",default:value,min:null,max:null,step:1,unit:"",choices:typeof value==="string"?[value]:[]}));
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[{key:"stairs",caption:"Stair cut",model:"StairCutModel",roi:"rect",icon:"patternSolidBox",parameters}],lensLookup},"test"));
    store.dispatch(processing.setPatternRoi({key:"stairs",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
    store.dispatch(scan.updateROI({x_origin:0,x_end:1,y_origin:0,y_end:1,scan_zoom:8}));
    store.dispatch(scan.updateVector({dwell:99,vector_resolution:64}));
    store.dispatch(image.setupVector({pattern:"default",edge:4,initialImage:new Uint16Array(16).fill(1234)}));
    const beforeScan=store.getState().scan, beforeImage=store.getState().image;
    await act(async()=>{renderer=create(React.createElement(Provider,{store},React.createElement(ExposureControls)));});
    const start=()=>renderer.root.findAllByType("button").find(b=>b.children.some(x=>x==="Start"));
    const stop=()=>renderer.root.findAllByType("button").find(b=>b.children.some(x=>x==="Stop"));
    const toggle=()=>renderer.root.findByProps({role:"switch"});
    const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
    assert.equal(renderer.root.findAllByType("button").length,2,"header contains only Stop and Start buttons plus the Parallel switch");
    assert.equal(toggle().props.checked,false); assert.equal(stop().props.disabled,true);
    assert.equal(start().props.disabled,false);
    await act(async()=>{start().props.onClick();start().props.onClick();}); await settle();
    assert.equal(sockets.length,1,"double-click starts only one exposure");
    assert.equal(start().props.disabled,true);assert.equal(stop().props.disabled,false);
    assert.equal(toggle().props.disabled,true);
    assert.equal(claimWorkspaceRun("scan"),null,"regular scan cannot enter during exposure");
    assert.equal(otherWorkspaceBusy("processing"),true,"other workspace sees exposure ownership");
    for(let i=0;i<5;i++) {
      const ws=sockets[i]; assert.ok(ws);
      assert.equal(ws.requests[0].pattern,"lattice");assert.equal(ws.requests[0].lattice.passes,2);
      assert.equal(ws.requests[0].lattice.dwell,7,"pattern dwell ignores scan dwell 99");
      await act(async()=>{ws.samples(12);ws.done();}); await settle();
    }
    assert.equal(sockets.length,5);assert.equal(store.getState().exposure.phase,"completed");
    assert.equal(store.getState().exposure.progress.length,5);
    assert.ok(store.getState().exposure.progress.every(n=>n.status==="completed"));
    assert.equal(store.getState().scan,beforeScan,"exposure never modifies scan phase, parameters or counters");
    assert.equal(store.getState().image,beforeImage,"exposure never modifies acquired pixels");
    // Stop remains exposure-owned and holds the instrument until the abort acknowledgement.
    await act(async()=>{start().props.onClick();}); await settle();
    const pending=sockets.at(-1);
    await act(async()=>{pending.samples(4);stop().props.onClick();});await settle();
    assert.equal(aborts,1);assert.equal(store.getState().exposure.phase,"stopping");
    assert.equal(claimWorkspaceRun("scan"),null);assert.equal(start().props.disabled,true);
    await act(async()=>{abortResolve();});await settle();
    assert.equal(store.getState().exposure.phase,"stopped");assert.equal(sockets.length,6,"Stop discards all future steps");
    assert.equal(store.getState().exposure.progress[0].exposure.receivedSamples,4);
    assert.equal(store.getState().scan,beforeScan);assert.equal(store.getState().image,beforeImage);
    const release=claimWorkspaceRun("scan");assert.ok(release);release();
    // Scan ownership disables the card and also guards direct invocation of Start.
    await act(async()=>store.dispatch(scan.streamStarted()));
    assert.equal(start().props.disabled,true);
    await act(async()=>start().props.onClick());await settle();assert.equal(sockets.length,6);
    await act(async()=>store.dispatch(scan.streamReset()));
    await act(async()=>toggle().props.onChange({target:{checked:true}}));
    assert.equal(store.getState().exposure.parallel,true);
    await act(async()=>start().props.onClick());await settle();
    assert.equal(sockets.at(-1).requests[0].lattice.passes,1,"Parallel submits one pass per visit");
    await act(async()=>stop().props.onClick());await settle();
    await act(async()=>abortResolve());await settle();
    // An exposure transport error never becomes a scan error.
    await act(async()=>start().props.onClick());await settle();
    await act(async()=>sockets.at(-1).onmessage({data:JSON.stringify({event:"error",detail:"test exposure fault"})}));await settle();
    assert.equal(store.getState().exposure.phase,"error");
    assert.equal(store.getState().exposure.error,"test exposure fault");
    assert.equal(store.getState().scan.phase,"idle");
    const afterError=claimWorkspaceRun("scan");assert.ok(afterError);afterError();
    // The cleaning-line restriction is visible before opening a stream.
    await act(async()=>{
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[{key:"clean",caption:"Clean line",model:"CleaningLineModel",roi:"rect",icon:"patternSolidBox",parameters}],lensLookup},"clean"));
      store.dispatch(processing.setPatternRoi({key:"clean",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
    });
    assert.equal(toggle().props.checked,true);assert.equal(start().props.disabled,true);
    await act(async()=>toggle().props.onChange({target:{checked:false}}));
    assert.equal(start().props.disabled,false);
  } finally {
    if(renderer)await act(async()=>renderer.unmount());await vite.close();Object.assign(globalThis,old);
  }
});
