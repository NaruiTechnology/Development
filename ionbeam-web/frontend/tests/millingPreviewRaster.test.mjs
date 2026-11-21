import test from "node:test";
import assert from "node:assert/strict";
import {millingSpotPositions,millingPreviewGeometry,millingPreviewMask,millingPreviewRadius,millingPreviewCoverage,millingPixelIndex,millingSampleOwners,millingDisplaySamples} from "../.test-dist/lib/millingLiveView.js";
const projection={x_origin:0,x_end:259.1,y_origin:0,y_end:502,scanGeometry:null};
const lattice={shape:{kind:"ellipse",cx:10572.1546875,cy:5580.459375,rx:768.3796471795085,ry:768.3796471795085},pitch_x:1.1063781816839575,pitch_y:.5710736879817975,axis:"x",dwell:7,passes:1};

test("recipe coverage is the union of exposure shapes and preserves holes and gaps",()=>{
 const p={x_origin:0,x_end:16383,y_origin:0,y_end:16383,scanGeometry:null};
 const ring={...lattice,shape:{kind:"ellipse",cx:30,cy:30,rx:20,ry:20,inner_rx:10,inner_ry:10},pitch_x:2,pitch_y:2};
 const box={...lattice,shape:{kind:"rect",x0:70,x1:90,y0:70,y1:90},pitch_x:2,pitch_y:2};
 const b={x_start:0,x_end:100,y_start:0,y_end:100};
 const {mask}=millingPreviewCoverage([ring,box],p,b,100);
 assert.equal(mask[millingPixelIndex(30,30,b,100)],0,"ring hole stays transparent");
 assert.equal(mask[millingPixelIndex(45,30,b,100)],1,"ring exposure is covered");
 assert.equal(mask[millingPixelIndex(80,80,b,100)],1,"the other recipe step is covered");
 assert.equal(mask[millingPixelIndex(60,60,b,100)],0,"space between emitted shapes is never filled");
});

test("logged unequal-axis circle maps every actual sample inside preview bounds without edge clamping",()=>{
 const {bounds}=millingPreviewGeometry(lattice,projection);
 assert.ok(Math.abs((bounds.y_end-bounds.y_start)/(bounds.x_end-bounds.x_start)-502/259.1)<1e-9);
 let count=0,outside=0;
 for(const [dx,dy] of millingSpotPositions(lattice)) {
   const x=dx/16383*259.1,y=dy/16383*502;
   if(x<bounds.x_start-.02||x>bounds.x_end+.02||y<bounds.y_start-.04||y>bounds.y_end+.04)outside++;
   count++;
 }
 assert.equal(count,2935031);assert.equal(outside,0);
});

test("bounded reconstruction removes high-resolution grid gaps while leaving raw validity unchanged",()=>{
 const n=2048,{bounds}=millingPreviewGeometry(lattice,projection);
 const valid=new Uint8Array(n*n);
 for(const [dx,dy] of millingSpotPositions(lattice))valid[millingPixelIndex(dx/16383*259.1,dy/16383*502,bounds,n)]=1;
 const before=valid.slice(),mask=millingPreviewMask(lattice,projection,bounds,n);
 const radius=millingPreviewRadius(lattice,projection,bounds,n);
 const started=performance.now(),owners=millingSampleOwners(valid,mask,n,radius);
 let gapsBefore=0,gapsAfter=0;
 for(let y=n/4;y<3*n/4;y++)for(let x=n/4;x<3*n/4;x++){
   const i=y*n+x;if(!valid[i])gapsBefore++;if(owners[i]<0)gapsAfter++;
 }
 assert.ok(gapsBefore>100000);assert.equal(gapsAfter,0);
 assert.deepEqual(valid,before,"reconstruction must not invent raw ADC measurements");
 for(let i=0;i<mask.length;i+=19){if(!mask[i])assert.equal(owners[i],-1);if(owners[i]>=0)assert.equal(valid[owners[i]],1);}
 console.log(`2048 preview reconstruction: ${Math.round(performance.now()-started)} ms; footprint radius ${radius}`);
});

test("ring hole, polygon exterior and unacquired regions remain transparent",()=>{
 const p={x_origin:0,x_end:16383,y_origin:0,y_end:16383,scanGeometry:null};
 for(const shape of [
   {kind:"ellipse",cx:100,cy:100,rx:20,ry:20,inner_rx:10,inner_ry:10},
   {kind:"polygon",points:[[80,80],[120,80],[80,120]]},
 ]) {
   const l={...lattice,shape,pitch_x:4,pitch_y:4},n=128,{bounds}=millingPreviewGeometry(l,p);
   const mask=millingPreviewMask(l,p,bounds,n),valid=new Uint8Array(n*n);
   for(const [x,y] of millingSpotPositions(l))if(y<90)valid[millingPixelIndex(x,y,bounds,n)]=1;
   const owners=millingSampleOwners(valid,mask,n,millingPreviewRadius(l,p,bounds,n));
   for(let i=0;i<mask.length;i++)if(!mask[i])assert.equal(owners[i],-1);
   assert.equal(owners[millingPixelIndex(100,115,bounds,n)],-1,"do not fill the unacquired half of the pattern");
   if(shape.kind==="ellipse")assert.equal(owners[millingPixelIndex(100,100,bounds,n)],-1,"preserve the ring hole");
 }
});


test("display gathering removes decimation stripes and retains qualifying exposure highlights",()=>{
 const n=2048,r=640,{bounds}=millingPreviewGeometry(lattice,projection),valid=new Uint8Array(n*n),change=new Float32Array(n*n).fill(-1);
 for(const [dx,dy] of millingSpotPositions(lattice))valid[millingPixelIndex(dx/16383*259.1,dy/16383*502,bounds,n)]=1;
 const mask=millingPreviewMask(lattice,projection,bounds,r),radius=millingPreviewRadius(lattice,projection,bounds,r);
 const first=valid.findIndex((v,i)=>v && i>n*n/2 && i%n>n/3 && i%n<2*n/3);change[first]=20;
 const started=performance.now(),display=millingDisplaySamples(valid,change,n,mask,r,radius);
 for(let y=r/4;y<3*r/4;y++)for(let x=r/4;x<3*r/4;x++)assert.ok(display.owners[y*r+x]>=0);
 for(let i=0;i<mask.length;i++)if(!mask[i])assert.equal(display.owners[i],-1);
 assert.ok(display.highlight.some(v=>v===20));
 console.log(`2048 measurements -> 640 display: ${Math.round(performance.now()-started)} ms`);
 assert.equal(valid.length,n*n);assert.equal(change[first],20);
});


test("calibrated affine projection keeps polygon bounds and its mask in the same coordinate space",()=>{
 const p={...projection,scanGeometry:{enabled:true,
   forward:{a:[1,.5,0,2],b:[10,-3]},inverse:{a:[1,-.25,0,.5],b:[-10.75,1.5]}}};
 const l={...lattice,shape:{kind:"polygon",points:[[10,20],[30,20],[10,40]]},pitch_x:2,pitch_y:2};
 const {bounds}=millingPreviewGeometry(l,p);
 assert.deepEqual(bounds,{x_start:30,x_end:50,y_start:37,y_end:77});
 const n=64,mask=millingPreviewMask(l,p,bounds,n);
 assert.equal(mask[millingPixelIndex(40,40,bounds,n)],1);
 assert.equal(mask[millingPixelIndex(48,70,bounds,n)],0);
});
