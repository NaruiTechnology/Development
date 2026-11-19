import test from "node:test";
import assert from "node:assert/strict";
import { liveStatistics, liveAutoLevels, normalizedLiveGray, liveChanges, CHANGE_ZERO } from "../.test-dist/lib/liveContrast.js";
import { levelGray } from "../.test-dist/lib/displayLevels.js";
import reducer,{resetMillingFrame,beginMillingPass,completeMillingPass,appendMillingSamples,restoreMillingHistory} from "../.test-dist/store/imageSlice.js";
const stats=values=>liveStatistics(values,new Uint8Array(values.length).fill(1));
test("exact quantiles recover a narrow ADC signal in the presence of extreme outliers",()=>{
 const values=[0,65532,...Array.from({length:10000},(_,i)=>40000+4*(i%25))];
 const s=stats(values),l=liveAutoLevels(s);
 assert.equal(l.low,40000);assert.equal(l.high,40096);
 assert.equal(levelGray(40000,l.low,l.high),0);assert.equal(levelGray(40096,l.low,l.high),255);
});
test("constant images, zero ADC and one-code noise do not get uncontrolled gain",()=>{
 const constant=liveAutoLevels(stats([40000,40000]));assert.equal(levelGray(40000,constant.low,constant.high),128);
 const l=liveAutoLevels(stats([40000,40004]));assert.ok(levelGray(40004,l.low,l.high)-levelGray(40000,l.low,l.high)<=32);
 const zero=liveStatistics([0,65000],[1,0]);assert.equal(zero.count,1);assert.equal(zero.mean,0);
});
test("normalization brightens near-average values, preserves in-band order and outside-band mapping",()=>{
 const values=Array.from({length:101},(_,i)=>40000+i*4),selected=stats(values),base={low:0,high:65532},range=[40000,40400];
 let previous=-1;
 for(const value of values){const g=normalizedLiveGray(value,base,selected,range,75);assert.ok(g>=previous);previous=g;}
 assert.ok(normalizedLiveGray(40200,base,selected,range,75)>=200);
 assert.equal(normalizedLiveGray(30000,base,selected,range,75),levelGray(30000,base.low,base.high));
 assert.equal(normalizedLiveGray(40200,base,selected,range,0),levelGray(40200,base.low,base.high));
 const empty=liveStatistics(values,new Uint8Array(values.length).fill(1),[0,100]);assert.equal(empty.count,0);
 assert.equal(normalizedLiveGray(40200,base,empty,[0,100],75),levelGray(40200,base.low,base.high));
});
test("completed pass history averages collisions, ignores missing pixels and survives a compatible run reset",()=>{
 const info={key:"p:1:exposure",bounds:{x_start:0,x_end:1,y_start:0,y_end:1},referenceKey:"pattern-grid-calibration"};
 let s=reducer(undefined,resetMillingFrame(info));s=reducer(s,beginMillingPass(info.key));
 s=reducer(s,appendMillingSamples({key:info.key,samples:[0,100,0,300,1,0]}));s=reducer(s,completeMillingPass(info.key));
 assert.equal(s.millingHistory.means[0],200);assert.equal(s.millingHistory.valid[1],1);
 const history=s.millingHistory;s=reducer(s,resetMillingFrame(null));assert.equal(s.millingHistory,history);
 s=reducer(s,resetMillingFrame(info));s=reducer(s,beginMillingPass(info.key));
 s=reducer(s,appendMillingSamples({key:info.key,samples:[0,202,0,206,2,999]}));
 const f=s.millingFrame,d=liveChanges(f.pixels,f.valid,f.sums,f.counts,f.previousMeans,f.previousValid,f.previousCounts);
 assert.equal(d.values[0]-CHANGE_ZERO,4);assert.equal(d.valid[0],1);assert.equal(d.valid[1],0);assert.equal(d.valid[2],0);
 const l=liveAutoLevels(liveStatistics(d.values,d.valid,[0,131064],131064),32,true);
 assert.equal(levelGray(CHANGE_ZERO,l.low,l.high),128);assert.ok(levelGray(d.values[0],l.low,l.high)>128);
 s=reducer(s,resetMillingFrame({...info,referenceKey:"changed-grid"}));s=reducer(s,beginMillingPass(info.key));assert.equal(s.millingFrame.previousMeans,null);
 const restored=reducer(undefined,restoreMillingHistory(history));assert.equal(restored.millingHistoryPersisted,true);
});
test("incomplete passes never replace the retained completed reference",()=>{
 const info={key:"p",bounds:{x_start:0,x_end:1,y_start:0,y_end:1}};
 let s=reducer(undefined,resetMillingFrame(info));s=reducer(s,beginMillingPass("p"));s=reducer(s,appendMillingSamples({key:"p",samples:[0,100]}));s=reducer(s,completeMillingPass("p"));
 const history=s.millingHistory;
 s=reducer(s,beginMillingPass("p"));s=reducer(s,appendMillingSamples({key:"p",samples:[0,500]}));s=reducer(s,resetMillingFrame(null));
 assert.equal(s.millingHistory,history);assert.equal(s.millingHistory.means[0],100);
});

test("partially accumulated preview pixels are not compared with a whole-pass average",()=>{
 const p=liveChanges([204],[1],[204],[1],[200],[1],[2]);assert.equal(p.valid[0],0);
 const completed=liveChanges([206],[1],[408],[2],[200],[1],[2]);assert.equal(completed.valid[0],1);assert.equal(completed.values[0]-CHANGE_ZERO,4);
});
