import React from "react";
import {createRoot} from "react-dom/client";
import {Provider} from "react-redux";
import {store} from "./src/store";
import {ProcessingPatternsPanel} from "./src/components/ProcessingPatternsPanel";
import {ExposureLatticeGeometry,ExposureLatticeMessage} from "./src/components/ExposureLatticeOverlay";
import {fetchProcessingPatterns,setPatternRoi} from "./src/store/processingSlice";
import {updateROI} from "./src/store/scanSlice";
import "./src/styles/theme.css";
const lookup={"schemaVersion": 1, "name": "LENS 1 PRELENS", "source": {"file": "LENS 1 PRELENS.xls", "sheet": "Sheet1", "range": "A1:F22", "sha256": "5dd6960120e36b1bc8646aedbbf1224af423fef829d81426b4b58c6a8efa723d"}, "sourceHeaders": ["Steps Between Apertures", "KV", "ID      (um)", "pA", "Lens 1   (kV)", "Spot Size   (Angstroms)"], "rows": [{"sourceRow": 2, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": "<10", "beamCurrentPA": "<1", "lens1KV": 14, "spotSizeAngstrom": 80}, {"sourceRow": 3, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": 20, "beamCurrentPA": 4, "lens1KV": 9.5, "spotSizeAngstrom": 120}, {"sourceRow": 4, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": 30, "beamCurrentPA": 11, "lens1KV": 8.4, "spotSizeAngstrom": 150}, {"sourceRow": 5, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": 70, "beamCurrentPA": 70, "lens1KV": 7.1, "spotSizeAngstrom": 250}, {"sourceRow": 6, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": 100, "beamCurrentPA": 150, "lens1KV": 6.65, "spotSizeAngstrom": 350}, {"sourceRow": 7, "stepsBetweenApertures": 2000, "beamVoltageKV": 30, "apertureDiameterUM": 150, "beamCurrentPA": 350, "lens1KV": 6.35, "spotSizeAngstrom": 550}, {"sourceRow": 8, "stepsBetweenApertures": 3000, "beamVoltageKV": 30, "apertureDiameterUM": 250, "beamCurrentPA": 1000, "lens1KV": 6.04, "spotSizeAngstrom": 800}, {"sourceRow": 9, "stepsBetweenApertures": 3000, "beamVoltageKV": 30, "apertureDiameterUM": 400, "beamCurrentPA": 2700, "lens1KV": "5.82*", "spotSizeAngstrom": 1200}, {"sourceRow": 10, "stepsBetweenApertures": 3000, "beamVoltageKV": 30, "apertureDiameterUM": 600, "beamCurrentPA": 6600, "lens1KV": "5.69*", "spotSizeAngstrom": 2700}, {"sourceRow": 11, "stepsBetweenApertures": 3000, "beamVoltageKV": 30, "apertureDiameterUM": 825, "beamCurrentPA": 11500, "lens1KV": "5.62*", "spotSizeAngstrom": 5000}, {"sourceRow": 12, "stepsBetweenApertures": null, "beamVoltageKV": 10, "apertureDiameterUM": 150, "beamCurrentPA": 250, "lens1KV": 3.1, "spotSizeAngstrom": 3000}], "notes": [{"sourceRow": 14, "text": "*Need to perform SLF for 2700pA, 6600pA and 11500pA beams. "}, {"sourceRow": 17, "text": "SLF "}, {"sourceRow": 18, "text": "At 11500 turn Lens 2 all the way down and focus with Lens 1.  This values is SLF."}, {"sourceRow": 20, "text": "SLF + .1 = Lens1 for 11500."}, {"sourceRow": 21, "text": "SLF + .2 = Lens1 for 6600."}, {"sourceRow": 22, "text": "SLF + .3 = Lens1 for 2700."}], "interpolation": "Exact match by voltage and current by default. Optional linear interpolation of spot size between numeric current anchors at the same voltage. No extrapolation; bounded current rows are reference only. Lens 1 settings are never interpolated."};
window.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,registered:true,user:{is_active:true,role:5}})}) as any;
class FixtureSocket {
 static OPEN=1;static CONNECTING=0;static CLOSING=2;static CLOSED=3;
 readyState=0;onopen:any;onmessage:any;onclose:any;timer:any;
 constructor(){setTimeout(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}},40);}
 send(){let count=0;this.timer=setInterval(()=>{if(this.readyState!==1)return;this.onmessage?.({data:new ArrayBuffer(12)});if(++count===100){clearInterval(this.timer);this.onmessage?.({data:JSON.stringify({event:"done"})});this.close();}},250);}
 close(){if(this.readyState>=2)return;this.readyState=3;clearInterval(this.timer);queueMicrotask(()=>this.onclose?.({code:1000}));}
}
window.WebSocket=FixtureSocket as any;
store.dispatch({type:"status/defaults/fulfilled",payload:{is_production:false,raster:{},vector:{}}});
const values={beamCurrent:150,dwell:1,overlap:50,axis:"x",steps:5,depth:1,direction:"down"};
const parameters=Object.entries(values).map(([name,value])=>({name,label:name,type:typeof value==="string"?"choice":"float",default:value,min:null,max:null,step:1,unit:"",choices:typeof value==="string"?[value]:[]}));
const patterns=[{key:"stairCut",caption:"Stair cut",model:"StairCutModel",roi:"rect",icon:"patternStairCut",parameters}];
store.dispatch(fetchProcessingPatterns.fulfilled({patterns,lensLookup:lookup} as any,"check"));
store.dispatch(updateROI({x_origin:0,x_end:1,y_origin:0,y_end:1}));
store.dispatch(setPatternRoi({key:"stairCut",roi:{x_start:0.1,x_end:0.9,y_start:0.1,y_end:0.9}}));
function Layout(){ return <main style={{display:"grid",gridTemplateColumns:"390px 1fr",gap:24,maxWidth:1020,margin:"24px auto",fontFamily:"sans-serif",color:"#e2e8f0"}}><div><h2>Processing · Patterns</h2><ProcessingPatternsPanel disabled={false}/><p style={{fontSize:12,color:"#94a3b8"}}>Exposure uses the pattern recipe. Regular scan controls remain separate.</p></div><div><div style={{position:"relative",aspectRatio:"1",background:"radial-gradient(ellipse at 30% 40%,#555,#151515)"}}><svg viewBox="0 0 640 640" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}><ExposureLatticeGeometry project={(x,y)=>({x:x*640,y:y*640})}/></svg></div><ExposureLatticeMessage/></div></main>; }
createRoot(document.getElementById("root")!).render(<Provider store={store}><Layout/></Provider>);
document.body.style.background="#0b1727";
