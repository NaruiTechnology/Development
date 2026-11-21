import { transform } from "./scanGeometry.js";
import type { ROIState } from "../store/scanSlice";
import type { LatticeRequest, LatticeShapeRequest, ROIRequest } from "../types/api";

function polygon(points: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i=0,j=points.length-1;i<points.length;j=i++) {
    const [xi,yi]=points[i], [xj,yj]=points[j];
    if (Math.abs((xj-xi)*(y-yi)-(yj-yi)*(x-xi)) <= 1e-10*Math.max(1,Math.hypot(xj-xi,yj-yi)) && x>=Math.min(xi,xj) && x<=Math.max(xi,xj) && y>=Math.min(yi,yj) && y<=Math.max(yi,yj)) return true;
    if ((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
export function millingShapeContains(s: LatticeShapeRequest,x:number,y:number): boolean {
  if(s.kind==="rect") return x>=s.x0 && x<=s.x1 && y>=s.y0 && y<=s.y1;
  if(s.kind==="ellipse") return ((x-s.cx)/s.rx)**2+((y-s.cy)/s.ry)**2<=1 &&
    (!(s.inner_rx && s.inner_ry) || ((x-s.cx)/s.inner_rx)**2+((y-s.cy)/s.inner_ry)**2>=1);
  return s.kind==="frame" ? polygon(s.outer,x,y) && !polygon(s.inner,x,y) : polygon(s.points,x,y);
}
/** Mirror the service lattice order, clipping, DAC rounding and dwell merging. */
export function* millingSpotPositions(l: LatticeRequest): Generator<[number,number]> {
  const s=l.shape;
  let x0:number,x1:number,y0:number,y1:number;
  if(s.kind==="rect") ({x0,x1,y0,y1}=s);
  else if(s.kind==="ellipse") {x0=s.cx-s.rx;x1=s.cx+s.rx;y0=s.cy-s.ry;y1=s.cy+s.ry;}
  else {const p=s.kind==="frame"?s.outer:s.points;x0=Math.min(...p.map(v=>v[0]));x1=Math.max(...p.map(v=>v[0]));y0=Math.min(...p.map(v=>v[1]));y1=Math.max(...p.map(v=>v[1]));}
  const nx=Math.max(1,Math.round((x1-x0)/l.pitch_x)),ny=Math.max(1,Math.round((y1-y0)/(l.pitch_y??l.pitch_x)));
  const pitchX=(x1-x0)/nx,pitchY=(y1-y0)/ny;
  const axis=l.axis==="long"?((x1-x0)>=(y1-y0)?"x":"y"):l.axis, fast=axis==="x"?nx:ny;
  for(let pass=0;pass<l.passes;pass++) {
    let pending:[number,number]|null=null, dwell=0;
    for(let cell=l.cell_start??0;cell<Math.min(l.cell_end??nx*ny,nx*ny);cell++) {
      const row=Math.floor(cell/fast),f=cell%fast,k=row%2?fast-1-f:f;
      const i=axis==="x"?k:row,j=axis==="x"?row:(row%2?ny-1-k:k);
      const cx=x0+(i+0.5)*pitchX,cy=y0+(j+0.5)*pitchY;
      if(!millingShapeContains(s,cx,cy)) continue;
      const x=Math.max(0,Math.min(16383,Math.round(cx))),y=Math.max(0,Math.min(16383,Math.round(cy)));
      if(pending && pending[0]===x && pending[1]===y && dwell+l.dwell+1<=65535) {dwell+=l.dwell+1;continue;}
      if(pending) yield pending;
      pending=[x,y];dwell=l.dwell;
    }
    if(pending) yield pending;
  }
}
/** Independent display window: magnify each side, preserve centre and fit the canvas. */
export function liveViewWindow(bounds: ROIRequest, zoom: number, field: {x_origin:number;x_end:number;y_origin:number;y_end:number}, offset={x:0,y:0}): ROIRequest {
  const xmin=Math.min(field.x_origin,field.x_end),xmax=Math.max(field.x_origin,field.x_end),ymin=Math.min(field.y_origin,field.y_end),ymax=Math.max(field.y_origin,field.y_end);
  const w=Math.min(xmax-xmin,Math.abs(bounds.x_end-bounds.x_start)*zoom),h=Math.min(ymax-ymin,Math.abs(bounds.y_end-bounds.y_start)*zoom);
  const cx=Math.max(xmin+w/2,Math.min(xmax-w/2,(bounds.x_start+bounds.x_end)/2+offset.x));
  const cy=Math.max(ymin+h/2,Math.min(ymax-h/2,(bounds.y_start+bounds.y_end)/2+offset.y));
  return {x_start:cx-w/2,x_end:cx+w/2,y_start:cy-h/2,y_end:cy+h/2};
}

/** Prefer a free window beside the pattern; use the least overlap if the field is crowded. */
export function defaultLiveViewOffset(bounds: ROIRequest, zoom: number, field: {x_origin:number;x_end:number;y_origin:number;y_end:number}): {x:number;y:number} {
  const w=Math.min(Math.abs(field.x_end-field.x_origin),Math.abs(bounds.x_end-bounds.x_start)*zoom);
  const h=Math.min(Math.abs(field.y_end-field.y_origin),Math.abs(bounds.y_end-bounds.y_start)*zoom);
  const gapX=Math.abs(field.x_end-field.x_origin)*0.02,gapY=Math.abs(field.y_end-field.y_origin)*0.02;
  const dx=(bounds.x_end-bounds.x_start+w)/2+gapX,dy=(bounds.y_end-bounds.y_start+h)/2+gapY;
  const candidates=[{x:dx,y:0},{x:-dx,y:0},{x:0,y:dy},{x:0,y:-dy}];
  let best=candidates[0],score=Infinity;
  for(const offset of candidates) {
    const b=liveViewWindow(bounds,zoom,field,offset);
    const overlap=Math.max(0,Math.min(b.x_end,bounds.x_end)-Math.max(b.x_start,bounds.x_start))*Math.max(0,Math.min(b.y_end,bounds.y_end)-Math.max(b.y_start,bounds.y_start));
    if(overlap<score){best=offset;score=overlap;}
    if(overlap===0)break;
  }
  return best;
}

/** Circular patterns use the X scale for their displayed radius; match it on both axes. */
export function circularLiveViewBounds(bounds: ROIRequest, field: {x_origin:number;x_end:number;y_origin:number;y_end:number}, viewport: {width:number;height:number}, zoom=1): ROIRequest {
  const scaleX=viewport.width/Math.abs(field.x_end-field.x_origin),scaleY=viewport.height/Math.abs(field.y_end-field.y_origin);
  const side=Math.min(Math.abs(bounds.x_end-bounds.x_start)*scaleX,Math.min(viewport.width,viewport.height)/Math.max(1,zoom));
  const cx=(bounds.x_start+bounds.x_end)/2,cy=(bounds.y_start+bounds.y_end)/2;
  return {x_start:cx-side/scaleX/2,x_end:cx+side/scaleX/2,y_start:cy-side/scaleY/2,y_end:cy+side/scaleY/2};
}


/** Exposure-only display sampling: derive density from the emitted lattice. */
export function millingPreviewResolution(lattice: LatticeRequest): number {
  const b=millingDacBounds(lattice);
  return Math.max(64,Math.min(640,Math.max(
    Math.round((b.x_end-b.x_start)/lattice.pitch_x),
    Math.round((b.y_end-b.y_start)/(lattice.pitch_y??lattice.pitch_x)))));
}

export function millingPixelIndex(x: number, y: number, bounds: ROIRequest, resolution: number): number {
  const px = Math.max(0, Math.min(resolution-1, Math.floor((x-bounds.x_start)/(bounds.x_end-bounds.x_start)*resolution)));
  const py = Math.max(0, Math.min(resolution-1, Math.floor((y-bounds.y_start)/(bounds.y_end-bounds.y_start)*resolution)));
  return py*resolution+px;
}


export type MillingProjection = Pick<ROIState,"x_origin"|"x_end"|"y_origin"|"y_end"|"scanGeometry">;
export function millingDacBounds(lattice: LatticeRequest): ROIRequest {
  const s=lattice.shape;
  if(s.kind==="rect")return {x_start:s.x0,x_end:s.x1,y_start:s.y0,y_end:s.y1};
  if(s.kind==="ellipse")return {x_start:s.cx-s.rx,x_end:s.cx+s.rx,y_start:s.cy-s.ry,y_end:s.cy+s.ry};
  const points=s.kind==="frame"?s.outer:s.points;
  return {x_start:Math.min(...points.map(p=>p[0])),x_end:Math.max(...points.map(p=>p[0])),
    y_start:Math.min(...points.map(p=>p[1])),y_end:Math.max(...points.map(p=>p[1]))};
}
export function projectedDac(x:number,y:number,p:MillingProjection):[number,number] {
  return p.scanGeometry?.enabled ? transform(p.scanGeometry.forward,[x,y]) : [
    Math.min(p.x_origin,p.x_end)+x/16383*Math.abs(p.x_end-p.x_origin),
    Math.min(p.y_origin,p.y_end)+y/16383*Math.abs(p.y_end-p.y_origin)];
}
/** Preview bounds come from the emitted geometry, never from a differently scaled UI circle. */
export function millingPreviewGeometry(lattice:LatticeRequest,p:MillingProjection) {
  const projection:MillingProjection={x_origin:p.x_origin,x_end:p.x_end,y_origin:p.y_origin,y_end:p.y_end,scanGeometry:p.scanGeometry};
  const b=millingDacBounds(lattice);
  const shape=lattice.shape;
  const vertices=shape.kind==="polygon" ? shape.points : shape.kind==="frame" ? shape.outer :
    [[b.x_start,b.y_start],[b.x_end,b.y_start],[b.x_end,b.y_end],[b.x_start,b.y_end]];
  const corners=vertices.map(([x,y])=>projectedDac(x,y,projection));
  const bounds={x_start:Math.min(...corners.map(p=>p[0])),x_end:Math.max(...corners.map(p=>p[0])),
    y_start:Math.min(...corners.map(p=>p[1])),y_end:Math.max(...corners.map(p=>p[1]))};
  if(lattice.shape.kind==="ellipse") {
    const s=lattice.shape,c=projectedDac(s.cx,s.cy,projection);
    const ex=projectedDac(s.cx+s.rx,s.cy,projection),ey=projectedDac(s.cx,s.cy+s.ry,projection);
    const rx=Math.hypot(ex[0]-c[0],ey[0]-c[0]),ry=Math.hypot(ex[1]-c[1],ey[1]-c[1]);
    bounds.x_start=c[0]-rx;bounds.x_end=c[0]+rx;bounds.y_start=c[1]-ry;bounds.y_end=c[1]+ry;
  }
  return {lattice,projection,bounds};
}
/** Shape mask is in the same calibrated coordinates as incoming spot samples. */
export function millingPreviewMask(lattice:LatticeRequest,p:MillingProjection,b:ROIRequest,n:number):Uint8Array {
  const mask=new Uint8Array(n*n),geometry=p.scanGeometry;
  const dx=(b.x_end-b.x_start)/n,dy=(b.y_end-b.y_start)/n;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const wx=b.x_start+(x+.5)*dx,wy=b.y_start+(y+.5)*dy;
    const [sx,sy]=geometry?.enabled ? transform(geometry.inverse,[wx,wy]) : [
      (wx-Math.min(p.x_origin,p.x_end))/Math.abs(p.x_end-p.x_origin)*16383,
      (wy-Math.min(p.y_origin,p.y_end))/Math.abs(p.y_end-p.y_origin)*16383];
    if(millingShapeContains(lattice.shape,sx,sy))mask[y*n+x]=1;
  }
  return mask;
}
/** Bound reconstruction to a cell footprint, including the hardware's one-DAC-code quantization. */
export function millingPreviewRadius(lattice:LatticeRequest,p:MillingProjection,b:ROIRequest,n:number):number {
  const d=millingDacBounds(lattice),nx=Math.max(1,Math.round((d.x_end-d.x_start)/lattice.pitch_x)),
    ny=Math.max(1,Math.round((d.y_end-d.y_start)/(lattice.pitch_y??lattice.pitch_x)));
  const sx=Math.max(1,Math.ceil((d.x_end-d.x_start)/nx)),sy=Math.max(1,Math.ceil((d.y_end-d.y_start)/ny));
  const c=projectedDac(0,0,p),ex=projectedDac(sx,0,p),ey=projectedDac(0,sy,p);
  const px=n/(b.x_end-b.x_start),py=n/(b.y_end-b.y_start);
  return Math.ceil((Math.hypot((ex[0]-c[0])*px,(ex[1]-c[1])*py)+Math.hypot((ey[0]-c[0])*px,(ey[1]-c[1])*py))/2)+1;
}
/** Coverage belongs to the emitted exposure shapes, including all recipe steps. */
export function millingPreviewCoverage(lattices:LatticeRequest[],p:MillingProjection,b:ROIRequest,resolution:number) {
  const mask=new Uint8Array(resolution*resolution);
  let radius=0;
  for(const lattice of lattices) {
    const shape=millingPreviewMask(lattice,p,b,resolution);
    for(let i=0;i<mask.length;i++)if(shape[i])mask[i]=1;
    radius=Math.max(radius,millingPreviewRadius(lattice,p,b,resolution));
  }
  return {resolution,mask,radius};
}
/** Display-only bounded nearest-sample reconstruction. Raw samples and validity are untouched. */
export function millingSampleOwners(valid:ArrayLike<number>,mask:Uint8Array,n:number,radius:number):Int32Array {
  const owners=new Int32Array(n*n).fill(-1),limit=radius*radius;
  for(let i=0;i<owners.length;i++)if(valid[i]&&mask[i])owners[i]=i;
  const consider=(i:number,x:number,y:number,candidate:number)=>{
    if(candidate<0)return;
    const cx=candidate%n,cy=Math.floor(candidate/n),distance=(cx-x)**2+(cy-y)**2;
    if(distance>limit)return;
    const old=owners[i];
    if(old<0||distance<(old%n-x)**2+(Math.floor(old/n)-y)**2)owners[i]=candidate;
  };
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const i=y*n+x;if(valid[i]||!mask[i])continue;
    if(x)consider(i,x,y,owners[i-1]);
    if(y){consider(i,x,y,owners[i-n]);if(x)consider(i,x,y,owners[i-n-1]);if(x+1<n)consider(i,x,y,owners[i-n+1]);}
  }
  for(let y=n-1;y>=0;y--)for(let x=n-1;x>=0;x--){
    const i=y*n+x;if(valid[i]||!mask[i])continue;
    if(x+1<n)consider(i,x,y,owners[i+1]);
    if(y+1<n){consider(i,x,y,owners[i+n]);if(x)consider(i,x,y,owners[i+n-1]);if(x+1<n)consider(i,x,y,owners[i+n+1]);}
  }
  return owners;
}


/** Gather measured pixels at display resolution before reconstruction, avoiding sparse nearest-neighbor decimation. */
export function millingDisplaySamples(valid:ArrayLike<number>,changes:ArrayLike<number>,rawResolution:number,
  mask:Uint8Array,resolution:number,radius:number) {
  const size=resolution*resolution,measured=new Uint8Array(size),source=new Int32Array(size).fill(-1),
    delta=new Float32Array(size).fill(-1),score=new Float32Array(size).fill(Infinity),scale=resolution/rawResolution;
  const columns=new Int32Array(rawResolution),horizontalDistance=new Float32Array(rawResolution);
  for(let x=0;x<rawResolution;x++){
    columns[x]=Math.min(resolution-1,Math.floor((x+.5)*scale));
    horizontalDistance[x]=(x-((columns[x]+.5)/scale-.5))**2;
  }
  for(let y=0;y<rawResolution;y++){
    const py=Math.min(resolution-1,Math.floor((y+.5)*scale)),row=py*resolution,
      verticalDistance=(y-((py+.5)/scale-.5))**2;
    for(let x=0;x<rawResolution;x++){
      const i=y*rawResolution+x;if(!valid[i])continue;
      const target=row+columns[x];if(!mask[target])continue;
      measured[target]=1;delta[target]=Math.max(delta[target],changes[i]??-1);
      const distance=horizontalDistance[x]+verticalDistance;
      if(distance<score[target]){source[target]=i;score[target]=distance;}
    }
  }
  const nearest=millingSampleOwners(measured,mask,resolution,radius),owners=new Int32Array(size).fill(-1),highlight=new Float32Array(size).fill(-1);
  for(let i=0;i<size;i++)if(nearest[i]>=0){owners[i]=source[nearest[i]];highlight[i]=delta[nearest[i]];}
  return {owners,highlight,resolution};
}
