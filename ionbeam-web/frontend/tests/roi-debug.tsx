import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../src/store';
import { ScanControls } from '../src/components/ScanControls';
import { updateROI, updateVector, addScanRegion, setScanZoom, setKind } from '../src/store/scanSlice';
import { fetchDefaults } from '../src/store/statusSlice';
import { stopAllScanActions } from '../src/hooks/scanActionRegistry';

const requests: any[] = [];
const phases: string[] = [];
window.fetch = async () => new Response(JSON.stringify({ok:true,registered:true,user:{is_active:true,role:2},rows:[]}), {headers:{'Content-Type':'application/json'}});
class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; readyState = 0;
  onopen: any; onmessage: any; onclose: any;
  constructor() { queueMicrotask(() => { this.readyState=1; this.onopen?.({}); }); }
  send(text: string) {
    const req=JSON.parse(text); requests.push(req);
    queueMicrotask(() => {
      const buf = new ArrayBuffer(req.vector_resolution ** 2 * 2);
      const view = new DataView(buf);
      for(let i=0;i<buf.byteLength;i+=2) view.setUint16(i, requests.length*10000);
      this.onmessage?.({data:buf});
      if (new URLSearchParams(location.search).has('infinite') && requests.length === 6) stopAllScanActions();
      this.onmessage?.({data:JSON.stringify({event:'done',chunks:1})});
      this.close();
    });
  }
  close() { if(this.readyState===3)return; this.readyState=3; this.onclose?.({code:1000,reason:''}); }
}
if (new URLSearchParams(location.search).has('real')) {
  const NativeSocket=window.WebSocket;
  window.WebSocket=class extends NativeSocket {
    constructor() { super('ws://127.0.0.1:8765/scan/vector/stream'); }
    send(text: string) { requests.push(JSON.parse(text)); super.send(text); }
  } as any;
} else window.WebSocket = FakeSocket as any;
store.dispatch(fetchDefaults.fulfilled({is_production:false,vector:{lineShiftPerXRow:0}} as any,'debug',undefined));
store.dispatch(setKind('vector'));
store.dispatch(updateVector({vector_resolution:1024,scan_path:'horizontal_sawtooth'}));
const source=document.createElement('canvas'); source.width=128; source.height=128;
const ctx=source.getContext('2d')!; ctx.fillStyle='rgb(100,100,100)'; ctx.fillRect(0,0,128,128);
store.dispatch(updateROI({x_origin:0,x_end:100,y_origin:0,y_end:100,imageDataUrl:source.toDataURL(),imageKind:'file',imageBounds:null}));
for(const r of [ {x_start:10,x_end:20,y_start:10,y_end:20}, {x_start:40,x_end:50,y_start:40,y_end:50}, {x_start:70,x_end:90,y_start:10,y_end:20} ]) store.dispatch(addScanRegion(r));
store.dispatch(setScanZoom(2));
store.subscribe(() => { const p=store.getState().scan.phase; if(phases.at(-1)!==p) phases.push(p); });
createRoot(document.getElementById('root')!).render(<Provider store={store}><ScanControls kind="vector" /></Provider>);
setTimeout(() => [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===(new URLSearchParams(location.search).has('infinite')?'Infinite':'Run'))?.click(), 500);
Object.assign(window,{roiDebug:()=>({requests:requests.map(({roi,vector_resolution})=>({roi,vector_resolution})),phases,error:store.getState().scan.errorMessage,values:[...new Set(store.getState().image.vectorImage)],cursor:store.getState().image.vectorCursor})});
