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
function contains(s: LatticeShapeRequest,x:number,y:number): boolean {
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
  const axis=l.axis==="long"?((x1-x0)>=(y1-y0)?"x":"y"):l.axis, fast=axis==="x"?nx:ny;
  for(let pass=0;pass<l.passes;pass++) {
    let pending:[number,number]|null=null, dwell=0;
    for(let cell=l.cell_start??0;cell<Math.min(l.cell_end??nx*ny,nx*ny);cell++) {
      const row=Math.floor(cell/fast),f=cell%fast,k=row%2?fast-1-f:f;
      const i=axis==="x"?k:row,j=axis==="x"?row:(row%2?ny-1-k:k);
      const cx=x0+(i+0.5)*(x1-x0)/nx,cy=y0+(j+0.5)*(y1-y0)/ny;
      if(!contains(s,cx,cy)) continue;
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
