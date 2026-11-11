import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url))).LensLookup;
test("Exposure controls default to serial and leave scan state and pixels intact", async()=>{
  const old = {window:globalThis.window, fetch:globalThis.fetch, WebSocket:globalThis.WebSocket};
  globalThis.window={location:{hostname:"example.test",port:"",protocol:"http:",host:"example.test"},
    localStorage:{getItem:()=>null,setItem(){}},addEventListener(){},removeEventListener(){},setTimeout,clearTimeout,setInterval,clearInterval};
  let account={ok:true,registered:true,user:{is_active:true,role:5}};
  let abortResolve=null, aborts=0;
  globalThis.fetch=async url=>{
    if(String(url).includes("/api/scan/abort")) {aborts++; return new Promise(resolve=>{abortResolve=()=>resolve({ok:true,status:200});});}
    return {ok:true,status:200,json:async()=>account};
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
    const {ProcessingPatternsPanel, ProcessingPatternCards}=await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const {ExposureLatticeMessage,ExposureLatticeGeometry}=await vite.ssrLoadModule("/src/components/ExposureLatticeOverlay.tsx");
    const processing=await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const {selectExposurePreview}=await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const scan=await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const image=await vite.ssrLoadModule("/src/store/imageSlice.ts");
    const {claimWorkspaceRun,otherWorkspaceBusy}=await vite.ssrLoadModule("/src/hooks/useScanWorkspace.ts");
    store.dispatch({type:"status/defaults/fulfilled",payload:{is_production:false,exposure_cell_ranges:true,raster:{},vector:{}}});
    const values={beamCurrent:150,dwell:1,overlap:50,axis:"x",steps:5,depth:1,passes:1};
    const parameters=Object.entries(values).map(([name,value])=>({name,label:name,type:typeof value==="string"?"choice":"float",default:value,min:null,max:null,step:1,unit:"",choices:typeof value==="string"?[value]:[]}));
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[{key:"stairs",caption:"Stair cut",model:"StairCutModel",roi:"rect",icon:"patternSolidBox",parameters}],lensLookup},"test"));
    store.dispatch(processing.setPatternRoi({key:"stairs",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
    store.dispatch(scan.updateROI({x_origin:0,x_end:1,y_origin:0,y_end:1,scan_zoom:8}));
    store.dispatch(scan.updateVector({dwell:99,vector_resolution:64}));
    store.dispatch(image.setupVector({pattern:"default",edge:4,initialImage:new Uint16Array(16).fill(1234)}));
    const beforeScan=store.getState().scan, beforeImage=store.getState().image;
    const layout = visible => React.createElement(Provider, {store},
      React.createElement(ProcessingPatternsPanel, {visible, disabled: false}),
      React.createElement(ExposureLatticeMessage),
      React.createElement("svg",null,React.createElement(ExposureLatticeGeometry,{project:(x,y)=>({x:x*640,y:y*640})})));
    await act(async()=>{renderer=create(layout(true));});
    const header=renderer.root.findByProps({className:"card__header patterns-card__header"});
    assert.equal(header.findAllByType("button").length,2,"View is not shown in the PATTERNS header");
    assert.equal(renderer.root.findAllByProps({className:"card patterns-exposure-card"}).length,0);
    const start=()=>renderer.root.findAllByType("button").find(b=>b.children.some(x=>x==="Start"));
    const stop=()=>renderer.root.findAllByType("button").find(b=>b.children.some(x=>x==="Stop"));
    const toggle=()=>renderer.root.findByProps({role:"switch"});
    const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,15));});
    await act(async()=>store.dispatch({type:"exposure/exposureFinished",payload:{phase:"error",error:"preflight timeout"}}));
    assert.match(renderer.root.findByProps({role:"alert"}).findByType("span").children.join(""), /preflight timeout/);
    assert.equal(toggle().props.checked,false); assert.equal(stop().props.disabled,true);
    assert.equal(start().props.disabled,false);
    await act(async()=>{start().props.onClick();start().props.onClick();}); await settle();
    assert.equal(sockets.length,1,"double-click starts only one exposure");
    assert.equal(start().props.disabled,true);assert.equal(stop().props.disabled,false);
    assert.equal(toggle().props.disabled,true);
    assert.equal(claimWorkspaceRun("scan"),null,"regular scan cannot enter during exposure");
    assert.equal(otherWorkspaceBusy("processing"),true,"other workspace sees exposure ownership");
    const spotCircles=()=>renderer.root.findByType(ExposureLatticeGeometry).findAllByType("circle");
    assert.ok(spotCircles().length>0,"the lattice is rendered on the canvas");
    assert.ok(spotCircles().every(circle=>circle.props.fill==="none" && circle.props.stroke),"planned spots and the running marker are hollow circles");
    await act(async()=>renderer.update(layout(false)));
    assert.equal(renderer.root.findByProps({hidden:true}).props.hidden,true);
    assert.equal(aborts,0,"hiding Patterns leaves the running exposure connected");
    for(let i=0;i<5;i++) {
      const ws=sockets[i]; assert.ok(ws);
      assert.equal(ws.requests[0].pattern,"lattice");assert.equal(ws.requests[0].lattice.passes,1);
      assert.equal(ws.requests[0].lattice.dwell,7,"pattern dwell ignores scan dwell 99");
      await act(async()=>{ws.samples(12);ws.done();}); await settle();
    }
    await act(async()=>renderer.update(layout(true)));
    assert.equal(sockets.length,5);assert.equal(store.getState().exposure.phase,"completed");
    assert.equal(store.getState().exposure.progress.length,5);
    assert.ok(store.getState().exposure.progress.every(n=>n.status==="completed"));
    assert.equal(store.getState().scan,beforeScan,"exposure never modifies scan phase, parameters or counters");
    assert.equal(store.getState().image,beforeImage,"exposure never modifies acquired pixels");
    assert.ok(spotCircles().every(circle=>circle.props.fill==="none"),"completed spots remain hollow");
    const savedTrace=structuredClone(store.getState().exposure.progress);
    await act(async()=>store.dispatch(scan.streamStarted()));
    await act(async()=>store.dispatch(image.resetVector()));
    assert.deepEqual(store.getState().exposure.progress,savedTrace,"starting a scan and replacing image pixels preserve the exposure trace");
    await act(async()=>store.dispatch(scan.streamReset()));
    const scanAfterTraceTest=store.getState().scan, imageAfterTraceTest=store.getState().image;
    account={ok:true,registered:true,session_expired:true,user:null};
    await act(async()=>start().props.onClick());await settle();
    assert.equal(store.getState().exposure.phase,"error");
    assert.match(store.getState().exposure.error,/Session expired/);
    assert.deepEqual(store.getState().exposure.progress,savedTrace,"failed authentication preserves the last completed trace");
    assert.equal(sockets.length,5,"expired auth is rejected before opening a stream");
    await act(async()=>{
      store.dispatch(processing.setPatternParameter({key:"stairs",name:"overlap",value:40}));
      store.dispatch(processing.setPatternRoi({key:"stairs",roi:{x_start:0.2,x_end:0.8,y_start:0.2,y_end:0.8}}));
      store.dispatch(processing.setPatternEnabled({key:"stairs",enabled:false}));
    });
    assert.deepEqual(selectExposurePreview(store.getState()),savedTrace,"recipe edits and disabling a pattern preserve the executed lattice");
    assert.equal(store.getState().exposure.progress.length,0,"edited recipes have fresh readouts");
    assert.ok(spotCircles().length>0,"retained spots stay on the canvas");
    await act(async()=>renderer.update(layout(false)));
    await act(async()=>renderer.update(layout(true)));
    assert.deepEqual(selectExposurePreview(store.getState()),savedTrace,"the retained preview survives tab changes");
    await act(async()=>store.dispatch(processing.setPatternEnabled({key:"stairs",enabled:true})));
    account={ok:true,registered:true,user:{is_active:true,role:5}};
    // Stop remains exposure-owned and holds the instrument until the abort acknowledgement.
    await act(async()=>{start().props.onClick();}); await settle();
    assert.equal(store.getState().exposure.retainedPreview.length,0,"a new prepared run replaces the retained preview");
    assert.notDeepEqual(selectExposurePreview(store.getState()),savedTrace,"the new run uses the edited recipe");
    const pending=sockets.at(-1);
    await act(async()=>{pending.samples(4);stop().props.onClick();});await settle();
    assert.equal(aborts,1);assert.equal(store.getState().exposure.phase,"stopping");
    assert.equal(claimWorkspaceRun("scan"),null);assert.equal(start().props.disabled,true);
    await act(async()=>{abortResolve();});await settle();
    assert.equal(store.getState().exposure.phase,"stopped");assert.equal(sockets.length,6,"Stop discards all future steps");
    assert.equal(store.getState().exposure.progress[0].exposure.receivedSamples,4);
    const stoppedTrace=structuredClone(selectExposurePreview(store.getState()));
    await act(async()=>store.dispatch(processing.setPatternParameter({key:"stairs",name:"overlap",value:50})));
    assert.deepEqual(selectExposurePreview(store.getState()),stoppedTrace,"stopped exposure spots remain after editing");
    const imageBeforeClear = store.getState().image;
    await act(async()=>store.dispatch(processing.clearPatternRoi("stairs")));
    assert.equal(store.getState().processing.instances.stairs.roi,null);
    assert.equal(store.getState().exposure.progress.length,0);
    assert.equal(store.getState().exposure.retainedPreview.length,0);
    assert.deepEqual(selectExposurePreview(store.getState()),[],"Remove clears the stopped lattice and depth bands");
    assert.equal(spotCircles().length,0,"cleared exposure geometry disappears from the canvas");
    assert.equal(store.getState().image,imageBeforeClear,"Remove preserves the acquired image");
    await act(async()=>store.dispatch(processing.setPatternRoi({key:"stairs",roi:{x_start:0.2,x_end:0.8,y_start:0.2,y_end:0.8}})));
    assert.equal(spotCircles().length,0,"redrawing the pattern does not resurrect its removed preview");

    assert.equal(store.getState().scan,scanAfterTraceTest);assert.equal(store.getState().image,imageAfterTraceTest);
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
    await act(async()=>sockets.at(-1).onmessage({data:JSON.stringify({event:"error",detail:"Exposure stream timed out"})}));await settle();
    assert.equal(store.getState().exposure.phase,"error");
    assert.equal(store.getState().exposure.error,"Exposure stream timed out");
    assert.equal(renderer.root.findByProps({role:"alert"}).findByType("span").children.join(""),"Exposure stream timed out");
    assert.equal(store.getState().scan.phase,"idle");
    await act(async()=>store.dispatch(processing.clearPatternRoi("stairs")));
    assert.equal(store.getState().exposure.progress.length,0,"Remove also clears a preview that has not been retained through an edit");
    assert.equal(spotCircles().length,0);

    const afterError=claimWorkspaceRun("scan");assert.ok(afterError);afterError();
    // The cleaning-line restriction is visible before opening a stream.
    await act(async()=>{
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[{key:"clean",caption:"Clean line",model:"CleaningLineModel",roi:"rect",icon:"patternSolidBox",parameters}],lensLookup},"clean"));
      store.dispatch(processing.setPatternRoi({key:"clean",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
    });
    assert.equal(toggle().props.checked,true);assert.equal(start().props.disabled,true);
    await act(async()=>toggle().props.onChange({target:{checked:false}}));
    assert.equal(start().props.disabled,false);
    await act(async()=>{
      const clean=store.getState().processing.specs[0];
      store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[
        {...clean,key:"box",caption:"Solid box",model:"SolidBoxModel"},clean
      ],lensLookup},"card-order"));
      store.dispatch(processing.setPatternRoi({key:"clean",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
      store.dispatch(processing.selectPattern("clean"));
      renderer.update(React.createElement(Provider,{store},React.createElement(ProcessingPatternCards,{disabled:true})));
    });
    assert.deepEqual(renderer.root.findAllByProps({role:"region"}).map(card=>card.props["data-pattern"]),["clean","box"]);
  } finally {
    if(renderer)await act(async()=>renderer.unmount());await vite.close();Object.assign(globalThis,old);
  }
});

test("View acquires one full-field frame between passes and Stop cancels the shared session", async () => {
  const previous = {window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket};
  globalThis.window = {
    location: {hostname: "example.test", port: "", protocol: "http:", host: "example.test"},
    localStorage: {getItem: () => null, setItem() {}},
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  let aborts = 0;
  let acknowledgeAbort;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/api/scan/abort")) {
      aborts++;
      return new Promise(resolve => { acknowledgeAbort = () => resolve({ok: true, status: 200}); });
    }
    return {ok: true, status: 200, json: async () => ({ok: true, registered: true, user: {is_active: true, role: 5}})};
  };
  const sockets = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; requests = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
    }
    send(data) { this.requests.push(JSON.parse(data)); }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      queueMicrotask(() => { this.readyState = 3; this.onclose?.({code: 1000}); });
    }
    samples(values) {
      const buffer = new ArrayBuffer(values.length * 2);
      const bytes = new DataView(buffer);
      values.forEach((value, i) => bytes.setUint16(i * 2, value, false));
      this.onmessage?.({data: buffer});
    }
    done() { this.onmessage?.({data: JSON.stringify({event: "done"})}); this.close(); }
    fail() { this.onmessage?.({data: JSON.stringify({event: "error", detail: "View device unavailable"})}); }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer;
  try {
    const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
    const store = getWorkspaceStore("processing");
    const {ExposureControls} = await vite.ssrLoadModule("/src/components/ExposureControls.tsx");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const exposure = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const scan = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const {claimWorkspaceRun} = await vite.ssrLoadModule("/src/hooks/useScanWorkspace.ts");
    store.dispatch({type: "status/defaults/fulfilled", payload: {is_production: false, exposure_cell_ranges: true, raster: {}, vector: {}}});
    const values = {beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", passes: 2};
    const parameters = Object.entries(values).map(([name, value]) => ({
      name, label: name, type: typeof value === "string" ? "choice" : "float",
      default: value, min: null, max: null, step: 1, unit: "", choices: typeof value === "string" ? [value] : [],
    }));
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({
      patterns: [{key: "box", caption: "Box", model: "SolidBoxModel", roi: "rect", icon: "patternSolidBox", parameters}],
      lensLookup,
    }, "view"));
    store.dispatch(processing.setPatternRoi({key: "box", roi: {x_start: 0.1, x_end: 0.9, y_start: 0.1, y_end: 0.9}}));
    store.dispatch(scan.updateROI({scan_zoom: 8, selection: {x_start: 0.1, x_end: 0.2, y_start: 0.1, y_end: 0.2}}));
    store.dispatch(scan.updateRaster({resolution: 4, dwell: 3, roi: {x_start: 20, x_end: 30, y_start: 20, y_end: 30}}));
    const originalScan = store.getState().scan;
    const button = label => renderer.root.findAllByType("button").find(item => item.children.includes(label));
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    await act(async () => { renderer = create(React.createElement(Provider, {store}, React.createElement(ExposureControls))); });
    assert.equal(button("View").props.disabled, false, "View is available without an active exposure");
    await act(async () => button("Start").props.onClick());
    await settle();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].requests[0].lattice.passes, 1, "serial exposure advances one pass at a time");
    await act(async () => { button("View").props.onClick(); button("View").props.onClick(); });
    assert.equal(sockets.length, 1, "View waits for the current pass");
    assert.equal(store.getState().exposure.viewPhase, "queued");
    assert.equal(button("View").props.disabled, true);
    const {exposureSegments} = await vite.ssrLoadModule("/src/lib/exposureSequence.ts");
    const firstPassSegments = [...exposureSegments(sockets[0].requests[0].lattice)];
    const finishLatticePass = async () => {
      for (const segment of firstPassSegments) {
        const active = sockets.at(-1);
        assert.deepEqual(active.requests[0].lattice, segment);
        await act(async () => active.done());
        await settle();
      }
      return sockets.at(-1);
    };
    for (let index = 0; index < firstPassSegments.length; index++) {
      const active = sockets[index];
      assert.deepEqual(active.requests[0].lattice, firstPassSegments[index]);
      await act(async () => { active.samples([42, 43]); active.done(); });
      await settle();
      if (index < firstPassSegments.length - 1) {
        assert.equal(sockets.length, index + 2, "View waits for the active lattice pass to finish");
        assert.equal(store.getState().exposure.viewPhase, "queued");
      }
    }
    assert.equal(sockets.length, firstPassSegments.length + 1);
    const view = sockets[firstPassSegments.length];
    assert.match(view.url, /\/ws\/scan\/raster\/stream/);
    assert.equal(view.requests[0].resolution, 4);
    assert.equal(view.requests[0].dwell, 3);
    assert.equal(view.requests[0].roi, null);
    assert.equal(view.requests[0].parallel_rois, null);
    assert.equal(view.requests[0].continuous, false);
    assert.equal(store.getState().exposure.viewPhase, "scanning");
    assert.equal(claimWorkspaceRun("scan"), null, "the exposure session keeps ownership during View");
    const pixels = Array.from({length: 16}, (_, i) => (i + 1) * 256);
    await act(async () => { view.samples(pixels.slice(0, 6)); view.samples(pixels.slice(6)); view.done(); });
    await settle();
    assert.equal(sockets.length, firstPassSegments.length + 2, "the next exposure pass resumes after View");
    assert.equal(store.getState().exposure.viewPhase, "completed");
    assert.deepEqual(Array.from(store.getState().image.frame), pixels);
    assert.deepEqual(Array.from(store.getState().image.vectorImage), pixels);
    assert.equal(store.getState().exposure.progress[0].exposure.receivedSamples, firstPassSegments.length * 2, "View pixels are excluded from exposure progress");
    assert.equal(store.getState().scan, originalScan, "View preserves scan phase, Zoom, ROI and scan settings");
    await finishLatticePass();
    assert.equal(store.getState().exposure.phase, "completed");

    // A failed View preserves the prior frame and exposure proceeds to the next pass.
    await act(async () => button("Start").props.onClick());
    await settle();
    await act(async () => { button("View").props.onClick(); });
    const failedView = await finishLatticePass();
    await act(async () => failedView.fail());
    await settle();
    assert.equal(store.getState().exposure.viewPhase, "error");
    assert.equal(store.getState().exposure.viewError, "View device unavailable");
    assert.equal(store.getState().exposure.phase, "running");
    assert.deepEqual(Array.from(store.getState().image.frame), pixels);
    assert.equal(sockets.at(-1).requests[0].pattern, "lattice");
    await finishLatticePass();

    // Stop during View aborts its stream and discards the remaining exposure pass.
    await act(async () => button("Start").props.onClick());
    await settle();
    await act(async () => { button("View").props.onClick(); });
    await finishLatticePass();
    const beforeStop = sockets.length;
    await act(async () => button("Stop").props.onClick());
    assert.equal(aborts, 1);
    assert.equal(claimWorkspaceRun("scan"), null, "ownership is held until abort acknowledgement");
    await act(async () => acknowledgeAbort());
    await settle();
    assert.equal(store.getState().exposure.phase, "stopped");
    assert.equal(store.getState().exposure.viewPhase, "stopped");
    assert.equal(sockets.length, beforeStop, "Stop prevents resuming exposure after View");
    const release = claimWorkspaceRun("scan");
    assert.ok(release);
    release();
    const exposureBeforeView = store.getState().exposure.progress;
    const beforeStandalone = sockets.length;
    await act(async () => { void button("View").props.onClick(); });
    await settle();
    assert.equal(sockets.length, beforeStandalone + 1, "idle View starts a scan immediately");
    assert.match(sockets.at(-1).url, /\/ws\/scan\/raster\/stream/);
    await act(async () => { sockets.at(-1).samples(pixels); sockets.at(-1).done(); });
    await settle();
    assert.equal(store.getState().exposure.viewPhase, "completed");
    assert.equal(store.getState().exposure.progress, exposureBeforeView);
    assert.deepEqual(Array.from(store.getState().image.vectorImage), pixels);
    const current = store.getState().exposure;
    const another = {...current.progress[0], id: "box:other:0:exposure"};
    const cleared = exposure.default({...current,
      progress: [...current.progress, another], retainedPreview: [another]},
      processing.clearPatternRoi("box"));
    assert.deepEqual(cleared.progress.map(node => node.id), [another.id], "Remove keeps other patterns, including keys sharing a prefix");
    assert.deepEqual(cleared.retainedPreview.map(node => node.id), [another.id]);
    await act(async () => store.dispatch(processing.undoPatternRoi()));
    assert.equal(store.getState().processing.instances.box.roi, null);
    assert.deepEqual(exposure.selectExposurePreview(store.getState()), [], "undoing the drawing hides its stopped exposure preview");

    const singlePattern = store.getState().processing.specs[0];
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({patterns:[
      singlePattern, {...singlePattern, key:"box2", caption:"Second box"},
    ], lensLookup}, "parallel-round"));
    store.dispatch(processing.setPatternRoi({key:"box",roi:{x_start:0.1,x_end:0.4,y_start:0.1,y_end:0.4}}));
    store.dispatch(processing.setPatternRoi({key:"box2",roi:{x_start:0.6,x_end:0.9,y_start:0.6,y_end:0.9}}));
    store.dispatch(exposure.setExposureParallel(true));
    await act(async()=>button("Start").props.onClick());
    await settle();
    const {exposureSegments: parallelSegments}=await vite.ssrLoadModule("/src/lib/exposureSequence.ts");
    const segments=[...parallelSegments(sockets.at(-1).requests[0].lattice)];
    const parallelPasses=Math.max(...store.getState().exposure.progress.map(node=>node.exposure.plan.passes));
    let patternShapes=[];
    for(let pass=0;pass<parallelPasses;pass++) for(const segment of segments) {
      const active=sockets.at(-1), lattice=active.requests[0].lattice;
      assert.equal(lattice.cell_start,segment.cell_start);
      assert.equal(lattice.cell_end,segment.cell_end);
      if(segment===segments[0]) patternShapes.push(lattice.shape);
      await act(async()=>{active.samples([31,32]);active.done();});
      await settle();
      const second=sockets.at(-1), secondLattice=second.requests[0].lattice;
      if(segment===segments[0]) patternShapes.push(secondLattice.shape);
      assert.deepEqual(secondLattice.shape,patternShapes[1],"parallel mode alternates to the second ROI in every round");
      assert.equal(secondLattice.cell_start,segment.cell_start);
      assert.equal(secondLattice.cell_end,segment.cell_end);
      await act(async()=>{second.samples([31,32]);second.done();});
      await settle();
    }
    assert.notDeepEqual(patternShapes[0],patternShapes[1],"the scheduled streams cover both pattern ROIs");
    const parallelProgress=store.getState().exposure.progress;
    assert.equal(parallelProgress.length,2);
    assert.ok(parallelProgress.every(node=>node.status==="completed"));
    assert.ok(parallelProgress.every(node=>node.exposure.receivedSamples===segments.length*parallelPasses*2),
      "each pattern receives only its own samples while both advance in alternating segments");
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    Object.assign(globalThis, previous);
  }
});
