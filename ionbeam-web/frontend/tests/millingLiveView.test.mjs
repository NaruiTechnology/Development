import test from "node:test";
import assert from "node:assert/strict";
import { millingSpotPositions, liveViewWindow, defaultLiveViewOffset, circularLiveViewBounds } from "../.test-dist/lib/millingLiveView.js";
import reducer, { resetMillingFrame, appendMillingSamples, beginMillingPass, completeMillingPass } from "../.test-dist/store/imageSlice.js";
const rect={shape:{kind:"rect",x0:0,x1:4,y0:0,y1:2},pitch_x:1,axis:"x",dwell:0,passes:1};
test("feedback maps exact serpentine spot order, segmented rows and vertical order",()=>{
 assert.deepEqual([...millingSpotPositions(rect)],[[1,1],[2,1],[3,1],[4,1],[4,2],[3,2],[2,2],[1,2]]);
 assert.deepEqual([...millingSpotPositions({...rect,cell_start:4,cell_end:7})],[[4,2],[3,2],[2,2]]);
 assert.deepEqual([...millingSpotPositions({...rect,axis:"y"})],[[1,1],[1,2],[2,1],[2,2],[3,1],[3,2],[4,1],[4,2]]);
});
test("sub-DAC spots merge just as the service does, respecting dwell saturation",()=>{
 const l={...rect,shape:{kind:"rect",x0:0,x1:0.4,y0:0,y1:0.4},pitch_x:0.1};
 assert.deepEqual([...millingSpotPositions(l)],[[0,0]]);
 assert.equal([...millingSpotPositions({...l,dwell:65535})].length,16);
});
test("shape clipping excludes ellipse holes and polygon exterior",()=>{
 const ellipse={...rect,shape:{kind:"ellipse",cx:2,cy:2,rx:2,ry:2,inner_rx:1,inner_ry:1}};
 const points=[...millingSpotPositions(ellipse)];assert.ok(points.length>0&&points.length<16);
 const triangle={...rect,shape:{kind:"polygon",points:[[0,0],[4,0],[0,4]]}};
 assert.equal([...millingSpotPositions(triangle)].length,10);
});
test("zoom scales display dimensions and dragging clamps it without editing source ROI",()=>{
 const bounds={x_start:30,x_end:40,y_start:40,y_end:60},field={x_origin:0,x_end:100,y_origin:0,y_end:100};
 assert.deepEqual(liveViewWindow(bounds,2,field),{x_start:25,x_end:45,y_start:30,y_end:70});
 assert.deepEqual(liveViewWindow(bounds,2,field,{x:100,y:-100}),{x_start:80,x_end:100,y_start:0,y_end:40});
 assert.equal(bounds.x_start,30);
});
test("feedback keeps valid zero ADC samples and ignores stale step chunks",()=>{
 let state=reducer(undefined,resetMillingFrame({key:"roi:1:exposure",bounds:{x_start:0,x_end:1,y_start:0,y_end:1}}));
 state=reducer(state,appendMillingSamples({key:"roi:1:exposure",samples:[0,0,1,65532]}));
 assert.equal(state.millingFrame.valid[0],1);assert.equal(state.millingFrame.pixels[0],0);
 assert.equal(state.millingFrame.pixels[1],65532);assert.equal(state.millingFrame.valid[2],0);
 const next=reducer(state,appendMillingSamples({key:"old",samples:[0,123]}));assert.equal(next.millingFrame.pixels[0],0);
});

test("editing a pattern invalidates stale live detector pixels",()=>{
 let state=reducer(undefined,resetMillingFrame({key:"roi:1:exposure",bounds:{x_start:0,x_end:1,y_start:0,y_end:1}}));
 state=reducer(state,{type:"processing/setPatternRoi",payload:{key:"roi",roi:{x_start:2,x_end:3,y_start:2,y_end:3}}});
 assert.equal(state.millingFrame,null);
});

test("default LiveView sits away from the ROI and chooses the other side near an edge",()=>{
 const field={x_origin:0,x_end:100,y_origin:0,y_end:100};
 for(const bounds of [{x_start:30,x_end:40,y_start:40,y_end:60},{x_start:85,x_end:95,y_start:40,y_end:60}]) {
   const window=liveViewWindow(bounds,2,field,defaultLiveViewOffset(bounds,2,field));
   assert.ok(window.x_end<=bounds.x_start || window.x_start>=bounds.x_end || window.y_end<=bounds.y_start || window.y_start>=bounds.y_end);
 }
});

test("circle LiveView is square in pixels with unequal physical X/Y scales",()=>{
 const field={x_origin:0,x_end:250,y_origin:0,y_end:500},viewport={width:640,height:640};
 const bounds={x_start:100,x_end:120,y_start:200,y_end:220};
 for(const zoom of [1,2,100]) {
   const sizing=circularLiveViewBounds(bounds,field,viewport,zoom);
   const view=liveViewWindow(sizing,zoom,field);
   const width=(view.x_end-view.x_start)/250*640,height=(view.y_end-view.y_start)/500*640;
   assert.ok(Math.abs(width-height)<1e-8);
 }
});


test("LiveImage remains visible between passes and fresh pixels replace it progressively",()=>{
 const key="circle:1:exposure",bounds={x_start:0,x_end:1,y_start:0,y_end:1};
 let state=reducer(undefined,resetMillingFrame({key,bounds}));
 state=reducer(state,beginMillingPass(key));
 state=reducer(state,appendMillingSamples({key,samples:[0,100,1,200,2,0]}));
 state=reducer(state,completeMillingPass(key));
 state=reducer(state,beginMillingPass(key));
 assert.deepEqual([...state.millingFrame.valid.slice(0,3)],[1,1,1]);
 assert.deepEqual([...state.millingFrame.pixels.slice(0,3)],[100,200,0]);
 assert.deepEqual([...state.millingFrame.counts.slice(0,3)],[0,0,0]);
 state=reducer(state,appendMillingSamples({key,samples:[0,400]}));
 assert.deepEqual([...state.millingFrame.pixels.slice(0,3)],[400,200,0]);
 state=reducer(state,completeMillingPass(key));
 assert.deepEqual([...state.millingFrame.completedValid.slice(0,3)],[1,0,0],"retained display pixels do not become fresh pass reference samples");
 assert.equal(state.millingFrame.completedMeans[0],400);
 state=reducer(state,resetMillingFrame({key:"different",bounds}));
 assert.equal(state.millingFrame.valid[0],0,"a different exposure starts with a fresh image");
});
