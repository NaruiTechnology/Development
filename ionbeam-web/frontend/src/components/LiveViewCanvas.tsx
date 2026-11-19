import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppSelector } from "../store";
import { useLevelSetting } from "../hooks/useLevelSetting";
import { buildHistogram, normalizeLevels, resolveLevels, levelGray } from "../lib/displayLevels";
import { patternBounds } from "../lib/processingPatterns";
import { liveViewWindow, defaultLiveViewOffset, circularLiveViewBounds } from "../lib/millingLiveView";
import { imageWorldBounds, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";
import { LevelWedge } from "./LevelWedge";

type Point = {x:number;y:number};
/** Transparent, detector-only preview. Dragging relocates its display, never the milling path. */
export function LiveViewCanvas({contrastHost, pointerWorld}: {contrastHost: HTMLElement|null; pointerWorld:(x:number,y:number)=>Point}) {
  const roi=useAppSelector(s=>s.scan.roi),patterns=useAppSelector(s=>s.processing);
  const zoom=useAppSelector(s=>s.exposure.viewZoom),rawFrame=useAppSelector(s=>s.image.millingFrame);
  const frame=rawFrame?.key.startsWith(`${patterns.activeKey}:`)?rawFrame:null;
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const [offset,setOffset]=useState<Point|null>(null);
  const drag=useRef<{start:Point;offset:Point}|null>(null);
  const active=patterns.instances[patterns.activeKey??""]?.roi;
  const shapeKey=JSON.stringify([patterns.activeKey,active]);
  useEffect(()=>{setOffset(null);},[shapeKey]);
  const source=active?patternBounds(active):null;
  const field=imageWorldBounds(roi),viewport=viewportBounds(roi);
  const sizing=source && active && "cx" in active ? circularLiveViewBounds(source,field,viewport,zoom) : source;
  const placement=offset ?? (sizing?defaultLiveViewOffset(sizing,zoom,field):{x:0,y:0});
  const window=sizing?liveViewWindow(sizing,zoom,field,placement):null;
  const [setting,setSetting]=useLevelSetting("milling-live");
  const histogram=useMemo(()=> {
    let min=65532,max=0,total=0;
    if(frame) for(let i=0;i<frame.pixels.length;i++) if(frame.valid[i]) {min=Math.min(min,frame.pixels[i]);max=Math.max(max,frame.pixels[i]);total++;}
    return buildHistogram(min,max,total,visit=>{if(frame)for(let i=0;i<frame.pixels.length;i++)if(frame.valid[i])visit(frame.pixels[i]);});
  },[frame]);
  const levels=setting.mode==="auto" && histogram.total?normalizeLevels(histogram.min,histogram.max):resolveLevels(histogram,setting);
  const cx=(x:number)=>worldToCanvasX(x,field,viewport),cy=(y:number)=>worldToCanvasY(y,field,viewport);
  useEffect(()=> {
    const canvas=canvasRef.current,ctx=canvas?.getContext("2d");
    if(!canvas||!ctx)return;
    ctx.clearRect(0,0,640,640);
    if(!frame||!window||!source || !frame.key.startsWith(`${patterns.activeKey}:`))return;
    const scratch=document.createElement("canvas");scratch.width=scratch.height=frame.resolution;
    const c=scratch.getContext("2d");if(!c)return;
    const image=c.createImageData(frame.resolution,frame.resolution);
    for(let i=0;i<frame.pixels.length;i++) if(frame.valid[i]) {
      const gray=levelGray(frame.pixels[i],levels.low,levels.high),p=i*4;
      image.data[p]=image.data[p+1]=image.data[p+2]=gray;image.data[p+3]=255;
    }
    c.putImageData(image,0,0);
    // Recipe sub-bands occupy the same relative position inside the magnified window.
    const mapX=(x:number)=>window.x_start+(x-source.x_start)/(source.x_end-source.x_start)*(window.x_end-window.x_start);
    const mapY=(y:number)=>window.y_start+(y-source.y_start)/(source.y_end-source.y_start)*(window.y_end-window.y_start);
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(scratch,cx(mapX(frame.bounds.x_start)),cy(mapY(frame.bounds.y_start)),cx(mapX(frame.bounds.x_end))-cx(mapX(frame.bounds.x_start)),cy(mapY(frame.bounds.y_end))-cy(mapY(frame.bounds.y_start)));
  },[frame,levels.low,levels.high,shapeKey,zoom,offset,roi]);
  return <>
    <div className="milling-live-layer" aria-label="LiveViewCanvas">
      <canvas ref={canvasRef} width={640} height={640} aria-label="Milling spot feedback image" />
      {window && <div className="milling-live-window" role="group" aria-label="Draggable LiveView rectangle"
        style={{left:`${cx(window.x_start)/6.4}%`,top:`${cy(window.y_start)/6.4}%`,width:`${(cx(window.x_end)-cx(window.x_start))/6.4}%`,height:`${(cy(window.y_end)-cy(window.y_start))/6.4}%`}}
        onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();drag.current={start:pointerWorld(e.clientX,e.clientY),offset:placement};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(!drag.current)return;const p=pointerWorld(e.clientX,e.clientY);setOffset({x:drag.current.offset.x+p.x-drag.current.start.x,y:drag.current.offset.y+p.y-drag.current.start.y});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
        <span>LiveView · {zoom}×</span>
      </div>}
    </div>
    {contrastHost && createPortal(<LevelWedge scopeLabel="ROIContrast" histogram={histogram} levels={levels}
      auto={setting.mode==="auto"} onChange={next=>setSetting({mode:"manual",...next})} onAuto={()=>setSetting({mode:"auto"})}
      disabled={!histogram.total || !source}/>,contrastHost)}
  </>;
}
