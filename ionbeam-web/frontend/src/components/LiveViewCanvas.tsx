import { promotedMillingGray } from "../lib/millingChange";
import { CHANGE_ZERO, LIVE_FULL_SCALE, liveAutoLevels, liveChanges, liveStatistics, normalizedLiveGray } from "../lib/liveContrast";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppSelector } from "../store";
import { useLevelSetting } from "../hooks/useLevelSetting";
import { levelGray, type ResolvedLevels } from "../lib/displayLevels";
import { patternBounds } from "../lib/processingPatterns";
import { liveViewWindow, defaultLiveViewOffset, circularLiveViewBounds, millingPreviewMask, millingPreviewRadius, millingDisplaySamples } from "../lib/millingLiveView";
import { imageWorldBounds, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";
import { LevelWedge } from "./LevelWedge";

type Point = {x:number;y:number};
/** Transparent, detector-only preview. Dragging relocates its display, never the milling path. */
export function LiveViewCanvas({contrastHost, toolsHost, pointerWorld}: {contrastHost: HTMLElement|null; toolsHost:HTMLElement|null; pointerWorld:(x:number,y:number)=>Point}) {
  const roi=useAppSelector(s=>s.scan.roi),patterns=useAppSelector(s=>s.processing);
  const threshold=useAppSelector(s=>s.exposure.millingChangeThresholdPercent);
  const zoom=useAppSelector(s=>s.exposure.viewZoom),rawFrame=useAppSelector(s=>s.image.millingFrame);
  const frame=rawFrame?.key.startsWith(`${patterns.activeKey}:`)?rawFrame:null;
  const referenceSaved=useAppSelector(s=>s.image.millingHistoryPersisted);
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const [offset,setOffset]=useState<Point|null>(null);
  const drag=useRef<{start:Point;offset:Point}|null>(null);
  const active=patterns.instances[patterns.activeKey??""]?.roi;
  const shapeKey=JSON.stringify([patterns.activeKey,active]);
  useEffect(()=>{setOffset(null);},[shapeKey]);
  const source=frame?.bounds ?? (active?patternBounds(active):null);
  const field=imageWorldBounds(roi),viewport=viewportBounds(roi);
  const sizing=source && active && "cx" in active ? circularLiveViewBounds(source,field,viewport,zoom) : source;
  const placement=offset ?? (sizing?defaultLiveViewOffset(sizing,zoom,field):{x:0,y:0});
  const window=sizing?liveViewWindow(sizing,zoom,field,placement):null;
  const [mode,setMode]=useState<"auto"|"change"|"normalize">("auto");
  const [rawSetting,setRawSetting]=useLevelSetting("milling-live");
  const [deltaSetting,setDeltaSetting]=useLevelSetting("milling-change");
  const setting=mode==="change"?deltaSetting:rawSetting;
  const setSetting=mode==="change"?setDeltaSetting:setRawSetting;
  const [strength,setStrength]=useState(75);
  const [band,setBand]=useState<[number,number]>([0,16383]),[bandEnabled,setBandEnabled]=useState(true);
  const [autoEpoch,setAutoEpoch]=useState(0);
  const minimumWindow=8*4;
  const rawStats=useMemo(()=>liveStatistics(frame?.pixels??[],frame?.valid??[]),[frame]);
  const changes=useMemo(()=>liveChanges(frame?.pixels??[],frame?.valid??[],frame?.sums,frame?.counts,frame?.previousMeans,frame?.previousValid,frame?.previousCounts),[frame]);
  const changeStats=useMemo(()=>liveStatistics(changes.values,changes.valid,[0,LIVE_FULL_SCALE*2],LIVE_FULL_SCALE*2),[changes]);
  const sampleBand: [number,number]=bandEnabled?[band[0]*4,band[1]*4]:[0,LIVE_FULL_SCALE];
  const selectedStats=useMemo(()=>liveStatistics(frame?.pixels??[],frame?.valid??[],sampleBand),[frame,band[0],band[1],bandEnabled]);
  const stats=mode==="change"?changeStats:rawStats;
  // Keep the wedge spectrum in sync with the white pixels promoted by the
  // Change threshold in the LiveView image. Auto levels still use the
  // unmodified detector statistics so moving the threshold cannot shift them.
  const spectrumStats=useMemo(()=>{
    const sourceValues=mode==="change"?changes.values:frame?.pixels??[];
    const valid=mode==="change"?changes.valid:frame?.valid??[];
    const values=new Float64Array(sourceValues.length);
    const fullScale=mode==="change"?LIVE_FULL_SCALE*2:LIVE_FULL_SCALE;
    let highlighted=0,total=0;
    for(let i=0;i<sourceValues.length;i++)if(valid[i])
      {
        total++;
        const change=frame?.changePercent[i]??-1;
        if(change>=0&&change>=threshold){values[i]=fullScale;highlighted++;}
        else values[i]=sourceValues[i];
      }
    return {...liveStatistics(values,valid,[0,fullScale],fullScale),highlighted,total};
  },[frame,mode,changes,threshold]);
  const target=liveAutoLevels(stats,minimumWindow,mode==="change");
  const context=`${frame?.key}:${shapeKey}:${mode}:${stats.count>0}:${autoEpoch}:${setting.mode}`;
  const [autoLevels,setAutoLevels]=useState<ResolvedLevels>(target);
  const lastContext=useRef(context),shownLevels=useRef(autoLevels);
  useEffect(()=>{
    let id=0;
    if(lastContext.current!==context){lastContext.current=context;shownLevels.current=target;setAutoLevels(target);return;}
    const from=shownLevels.current,start=performance.now();
    const tick=(now:number)=>{
      const t=Math.min(1,(now-start)/180);
      const next={low:from.low+(target.low-from.low)*t,high:from.high+(target.high-from.high)*t};
      shownLevels.current=next;setAutoLevels(next);
      if(t<1)id=requestAnimationFrame(tick);
    };
    id=requestAnimationFrame(tick);return()=>cancelAnimationFrame(id);
  },[target.low,target.high,context]);
  const levels=setting.mode==="auto"?autoLevels:setting;
  const aroundMean=()=>{
    const mean=rawStats.mean/4,radius=Math.max(8,rawStats.deviation/4);
    setBand([Math.max(0,Math.floor(mean-radius)),Math.min(16383,Math.ceil(mean+radius))]);setBandEnabled(true);
  };
  const coverage=useMemo(()=>frame?.lattice&&frame.projection ? {
    resolution:Math.min(frame.resolution,640),
    mask:millingPreviewMask(frame.lattice,frame.projection,frame.bounds,Math.min(frame.resolution,640)),
    radius:millingPreviewRadius(frame.lattice,frame.projection,frame.bounds,Math.min(frame.resolution,640)),
  }:null,[frame?.lattice,frame?.projection,frame?.bounds,frame?.resolution]);
  const display=useMemo(()=>frame&&coverage ? millingDisplaySamples(
    mode==="change"?changes.valid:frame.valid,frame.changePercent,frame.resolution,
    coverage.mask,coverage.resolution,coverage.radius):null,[frame,coverage,mode,changes]);
  const histogram=spectrumStats.histogram;
  const cx=(x:number)=>worldToCanvasX(x,field,viewport),cy=(y:number)=>worldToCanvasY(y,field,viewport);
  useEffect(()=> {
    const canvas=canvasRef.current,ctx=canvas?.getContext("2d");
    if(!canvas||!ctx)return;
    ctx.clearRect(0,0,640,640);
    if(!frame||!window||!source || !frame.key.startsWith(`${patterns.activeKey}:`))return;
    const edge=display?.resolution??frame.resolution;
    const scratch=document.createElement("canvas");scratch.width=scratch.height=edge;
    const c=scratch.getContext("2d");if(!c)return;
    const image=c.createImageData(edge,edge);
    for(let pIndex=0;pIndex<edge*edge;pIndex++) {
      const i=display?display.owners[pIndex]:((mode==="change"?changes.valid[pIndex]:frame.valid[pIndex])?pIndex:-1);
      if(i<0)continue;
      const gray=mode==="change"?levelGray(changes.values[i],levels.low,levels.high):mode==="normalize"&&bandEnabled?
        normalizedLiveGray(frame.pixels[i],levels,selectedStats,sampleBand,strength,minimumWindow):levelGray(frame.pixels[i],levels.low,levels.high),p=pIndex*4;
      const displayedGray=promotedMillingGray(gray,display?.highlight[pIndex]??frame.changePercent[i],threshold);
      image.data[p]=image.data[p+1]=image.data[p+2]=displayedGray;image.data[p+3]=255;
    }
    c.putImageData(image,0,0);
    // Recipe sub-bands occupy the same relative position inside the magnified window.
    const mapX=(x:number)=>window.x_start+(x-source.x_start)/(source.x_end-source.x_start)*(window.x_end-window.x_start);
    const mapY=(y:number)=>window.y_start+(y-source.y_start)/(source.y_end-source.y_start)*(window.y_end-window.y_start);
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(scratch,cx(mapX(frame.bounds.x_start)),cy(mapY(frame.bounds.y_start)),cx(mapX(frame.bounds.x_end))-cx(mapX(frame.bounds.x_start)),cy(mapY(frame.bounds.y_end))-cy(mapY(frame.bounds.y_start)));
  },[frame,display,threshold,levels.low,levels.high,shapeKey,zoom,offset,roi,mode,changes,selectedStats,band[0],band[1],bandEnabled,strength,minimumWindow]);
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
    {contrastHost && createPortal(<div className="live-contrast-control">
      <label className="live-contrast-mode">View
        <select aria-label="LiveView contrast mode" value={mode} onChange={e=>{
          const next=e.target.value as typeof mode;setMode(next);if(next==="normalize"&&rawStats.count)aroundMean();
        }}>
          <option value="auto">Enhanced Auto</option><option value="change">Change</option><option value="normalize">Normalize range</option>
        </select>
      </label>
      <LevelWedge scopeLabel={mode==="change"?"Δ previous pass (ADC)":"ROIContrast"} histogram={histogram} levels={levels}
        fullScale={mode==="change"?LIVE_FULL_SCALE*2:LIVE_FULL_SCALE} codeOffset={mode==="change"?CHANGE_ZERO:0}
        auto={setting.mode==="auto"} onChange={next=>setSetting({mode:"manual",...next})} onAuto={()=>{setSetting({mode:"auto"});setAutoEpoch(n=>n+1);}}
        disabled={!stats.count||!source}/>
      {mode==="change"&&!stats.count&&<small role="status">{frame?.previousMeans?"Waiting for matching pixels":"First pass establishes reference"}</small>}
      {frame?.pass&&frame.pass>1&&<small role="status">Change threshold highlights · {spectrumStats.highlighted.toLocaleString()} / {spectrumStats.total.toLocaleString()} samples · {threshold}%</small>}
      {mode==="change"&&stats.count>0&&<small>Preview-pixel change · pass {frame?.pass??1}</small>}
      {mode==="change"&&frame?.completedMeans&&<small>{referenceSaved?"Reference saved locally":"Reference retained in session"}</small>}
    </div>,contrastHost)}
    {toolsHost&&mode==="normalize"&&createPortal(<div className="live-normalize-toolbar">
      <label><input type="checkbox" aria-label="Enable LiveView normalization range" checked={bandEnabled} onChange={e=>setBandEnabled(e.target.checked)}/> Brighten range (ADC)</label>
      <div className="live-normalize-range">
        <div className="vector-gray-levels__values"><span>{band[0]}</span><span>{band[1]}</span></div>
        <div className="vector-gray-levels__slider">
          <div className="vector-gray-levels__track"/><div className="vector-gray-levels__selection" style={{left:`${band[0]/16383*100}%`,width:`${(band[1]-band[0])/16383*100}%`}}/>
          <input className="vector-gray-levels__range" type="range" min={0} max={16383} step={1} value={band[0]} disabled={!bandEnabled} aria-label="LiveView normalization minimum ADC" onChange={e=>setBand([Math.min(Number(e.target.value),band[1]),band[1]])}/>
          <input className="vector-gray-levels__range" type="range" min={0} max={16383} step={1} value={band[1]} disabled={!bandEnabled} aria-label="LiveView normalization maximum ADC" onChange={e=>setBand([band[0],Math.max(band[0],Number(e.target.value))])}/>
        </div>
      </div>
      <button type="button" className="btn btn--ghost" disabled={!rawStats.count} onClick={aroundMean}>Around mean</button>
      <label>Brightness <input type="range" min={0} max={100} value={strength} aria-label="LiveView normalization brightness" onChange={e=>setStrength(Number(e.target.value))}/><output>{strength}%</output></label>
      <button type="button" className="btn btn--ghost" onClick={()=>{setBand([0,16383]);setBandEnabled(true);setStrength(75);setSetting({mode:"auto"});}}>Reset</button>
      <span role="status">{!bandEnabled?"Range brightening off":selectedStats.count?`Mean ${(selectedStats.mean/4).toFixed(1)} ADC · ${selectedStats.count.toLocaleString()} preview pixels`:"No acquired pixels in range"}</span>
    </div>,toolsHost)}
  </>;
}
