import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

test("exposure samples use frozen lattice geometry and reject incomplete feedback", {timeout:30000}, async () => {
  const keys=["window","fetch","WebSocket"];
  const previous=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  globalThis.window={location:{hostname:"example.test",protocol:"http:",host:"example.test"},
    localStorage:{getItem:()=>JSON.stringify({session_token:"test"}),setItem(){}},
    setTimeout,clearTimeout,setInterval,clearInterval,addEventListener(){},removeEventListener(){}};
  globalThis.fetch=async()=>({ok:true,json:async()=>({ok:true,registered:true,user:{is_active:true,role:5}})});
  const sockets=[];
  class Socket {
    static OPEN=1;static CLOSING=2;static CLOSED=3;
    readyState=0;requests=[];
    constructor(){sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(raw){this.requests.push(JSON.parse(raw));}
    close(){this.readyState=3;}
  }
  globalThis.WebSocket=Socket;
  const vite=await createServer({server:{middlewareMode:true,watch:null,ws:false},optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});
  let renderer,controls,completion;
  try {
    const {getWorkspaceStore}=await vite.ssrLoadModule("/src/store/index.ts");
    const store=getWorkspaceStore("processing");
    const {useExposureRun}=await vite.ssrLoadModule("/src/hooks/useExposureRun.ts");
    const processing=await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const scan=await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const {millingSpotPositions,millingPreviewResolution,millingPixelIndex,projectedDac}=await vite.ssrLoadModule("/src/lib/millingLiveView.ts");
    const lensLookup=JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url))).LensLookup;
    store.dispatch({type:"status/defaults/fulfilled",payload:{is_production:true,exposure_cell_ranges:false,exposure_session_stream:true,raster:{},vector:{}}});
    const values={beamCurrent:150,dwell:1,overlap:50,axis:"x",passes:1};
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[{key:"box",caption:"Box",model:"SolidBoxModel",roi:"rect",
      parameters:Object.entries(values).map(([name,value])=>({name,label:name,type:typeof value==="string"?"choice":"float",default:value,choices:typeof value==="string"?[value]:[]}))}],lensLookup},"test"));
    store.dispatch(scan.updateROI({x_origin:0,x_end:1,y_origin:0,y_end:2}));
    store.dispatch(processing.createPatternRoi({key:"box",roi:{x_start:.1,x_end:.3,y_start:.1,y_end:.3}}));
    function Harness(){controls=useExposureRun();return null;}
    await act(async()=>{renderer=create(React.createElement(Provider,{store},React.createElement(Harness)));});
    for(const incomplete of [false,true]) {
      const before=sockets.length;
      await act(async()=>{completion=controls.start();});
      for(let i=0;i<100&&sockets.length===before&&!store.getState().exposure.error;i++)
        await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});
      assert.equal(sockets.length,before+1,store.getState().exposure.error??"opens exposure stream");
      const socket=sockets.at(-1),request=socket.requests[0].request;
      const positions=[...millingSpotPositions(request.lattice)];
      const frame=store.getState().image.millingFrame;
      assert.equal(frame.resolution,millingPreviewResolution(request.lattice));
      // Regular scan controls may change while the exposure's mapping remains frozen.
      await act(async()=>{
        store.dispatch(scan.updateROI({x_end:100,y_end:500}));
        store.dispatch(scan.updateRaster({resolution:2048}));
      });
      const count=positions.length-(incomplete?1:0),buffer=new ArrayBuffer(count*2),data=new DataView(buffer);
      for(let i=0;i<count;i++)data.setUint16(i*2,100+i%200,false);
      await act(async()=>{
        socket.onmessage({data:buffer});
        socket.onmessage({data:JSON.stringify({event:"done"})});
        await completion;
      });
      if(incomplete) {
        assert.equal(store.getState().exposure.phase,"error");
        assert.match(store.getState().exposure.error,/before all lattice spots/);
      } else {
        assert.equal(store.getState().exposure.phase,"completed",store.getState().exposure.error);
        const result=store.getState().image.millingFrame;
        assert.equal(result.counts.reduce((a,b)=>a+b,0),positions.length);
        const expected=new Uint32Array(result.counts.length);
        for(const [x,y] of positions){const [wx,wy]=projectedDac(x,y,frame.projection);expected[millingPixelIndex(wx,wy,frame.bounds,frame.resolution)]++;}
        assert.deepEqual(result.counts,expected,"ADC values follow emitted spots in the exposure snapshot, not the changed scan field");
      }
      store.dispatch(scan.updateROI({x_end:1,y_end:2}));
    }
  } finally {
    if(renderer)await act(async()=>{controls.stop();renderer.unmount();});
    await completion;
    await vite.close();
    Object.assign(globalThis,previous);
  }
});
