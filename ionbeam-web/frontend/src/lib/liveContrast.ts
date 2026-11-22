import { buildHistogram, levelGray, normalizeLevels, type LevelHistogram, type ResolvedLevels } from "./displayLevels.js";
export const LIVE_FULL_SCALE = 65532;
export const CHANGE_ZERO = LIVE_FULL_SCALE;
export interface LiveStatistics { histogram: LevelHistogram; count: number; mean: number; deviation: number; low: number; high: number }
/** Exact raw-sample quantiles; only the plotted outline uses 512 bins. */
export function liveStatistics(values: ArrayLike<number>, valid: ArrayLike<number>, range: readonly [number,number]=[0,LIVE_FULL_SCALE], fullScale=LIVE_FULL_SCALE): LiveStatistics {
  const counts=new Uint32Array(fullScale+1);let n=0,sum=0,sum2=0,min=fullScale,max=0;
  for(let i=0;i<values.length;i++)if(valid[i] && Number.isFinite(values[i]) && values[i]>=range[0] && values[i]<=range[1]) {
    const v=Math.max(0,Math.min(fullScale,Math.round(values[i])));counts[v]++;n++;sum+=v;sum2+=v*v;min=Math.min(min,v);max=Math.max(max,v);
  }
  const quantile=(fraction:number)=>{let count=0;const target=Math.floor(Math.max(0,n-1)*fraction);for(let v=min;v<=max;v++){count+=counts[v];if(count>target)return v;}return 0;};
  const mean=n?sum/n:0;
  return {histogram:buildHistogram(min,max,n,visit=>{for(let v=min;v<=max;v++)for(let j=0;j<counts[v];j++)visit(v);}),count:n,mean,deviation:n?Math.sqrt(Math.max(0,sum2/n-mean*mean)):0,low:n?quantile(.005):0,high:n?quantile(.995):fullScale};
}
export function liveAutoLevels(stats: LiveStatistics, minimumWindow=32, change=false): ResolvedLevels {
  const full=change?LIVE_FULL_SCALE*2:LIVE_FULL_SCALE;
  if(!stats.count)return change?{low:CHANGE_ZERO-minimumWindow,high:CHANGE_ZERO+minimumWindow}:{low:0,high:full};
  if(change){const span=Math.max(minimumWindow,Math.abs(stats.low-CHANGE_ZERO),Math.abs(stats.high-CHANGE_ZERO));return {low:Math.max(0,CHANGE_ZERO-span),high:Math.min(full,CHANGE_ZERO+span)};}
  const width=Math.max(minimumWindow,stats.high-stats.low),centre=(stats.low+stats.high)/2;
  const low=Math.max(0,Math.min(full-width,centre-width/2));
  return normalizeLevels(low,Math.min(full,low+width),full);
}
/** Accept equal or stronger automatic gain; a weaker candidate cannot undo the boost. */
export function retainLiveContrast(previous: ResolvedLevels | null, next: ResolvedLevels, progressiveFactor=1): ResolvedLevels {
  const boundedFactor=Math.max(0,Math.min(1,progressiveFactor));
  const width=Math.min((previous?previous.high-previous.low:next.high-next.low)*boundedFactor,next.high-next.low);
  if(width>=next.high-next.low)return next;
  // Preserve the strongest window width while following a shifted signal.
  // Freezing the old absolute levels can clip a later pass whose ADC values
  // moved, making the image appear to lose its contrast enhancement.
  const centre=(next.low+next.high)/2;
  const low=Math.max(next.low,Math.min(next.high-width,centre-width/2));
  return {low,high:low+width};
}
/** Monotonic selected-band lift. Outside-band pixels retain the base display mapping. */
export function normalizedLiveGray(value:number,base:ResolvedLevels,selected:LiveStatistics,range:readonly[number,number],strength:number,minimumWindow=32):number {
  const gray=levelGray(value,base.low,base.high);
  if(!selected.count || value<range[0] || value>range[1] || strength<=0)return gray;
  const window=liveAutoLevels(selected,minimumWindow),t=Math.max(0,Math.min(1,(value-window.low)/(window.high-window.low)));
  const mean=Math.max(.05,Math.min(.95,(selected.mean-window.low)/(window.high-window.low)));
  const target=Math.max(mean,.5+.4*Math.max(0,Math.min(1,strength/100)));
  const gamma=Math.max(.1,Math.min(1,Math.log(target)/Math.log(mean)));
  return Math.max(gray,Math.round(255*Math.pow(t,gamma)));
}
/** Compare current pass averages only where a completed reference and current samples both exist. */
export function liveChanges(pixels:ArrayLike<number>, valid:ArrayLike<number>, sums?:ArrayLike<number>, counts?:ArrayLike<number>, previous?:ArrayLike<number>|null, previousValid?:ArrayLike<number>|null, previousCounts?:ArrayLike<number>|null):{values:Float64Array;valid:Uint8Array} {
  const values=new Float64Array(pixels.length),mask=new Uint8Array(pixels.length);
  if(previous&&previousValid)for(let i=0;i<pixels.length;i++)if(valid[i]&&previousValid[i]&&(!previousCounts||counts?.[i]===previousCounts[i])){
    values[i]=CHANGE_ZERO+(counts?.[i]?sums![i]/counts[i]:pixels[i])-previous[i];mask[i]=1;
  }
  return {values,valid:mask};
}
