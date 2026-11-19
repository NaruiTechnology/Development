import type { MillingHistory } from "../store/imageSlice";
/** One completed reference per workspace; IndexedDB preserves typed arrays without blocking acquisition. */
export async function millingHistoryStorage(workspace:string,write?:MillingHistory):Promise<MillingHistory|null> {
  if(typeof indexedDB==="undefined")return null;
  try { return await new Promise(resolve=>{
    const open=indexedDB.open("ionbeam-milling-reference",1);
    open.onupgradeneeded=()=>{if(!open.result.objectStoreNames.contains("reference"))open.result.createObjectStore("reference");};
    open.onerror=()=>resolve(null);open.onblocked=()=>resolve(null);
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction("reference",write?"readwrite":"readonly");
      const request=write?tx.objectStore("reference").put(write,workspace):tx.objectStore("reference").get(workspace);
      let result:MillingHistory|null=null;
      request.onsuccess=()=>{
        const candidate=write??request.result;
        const resolution=candidate?.resolution ?? Math.sqrt(candidate?.means?.length ?? 0);
        const size=resolution*resolution;
        if(Number.isInteger(resolution) && resolution>=1 && resolution<=2048 && candidate && typeof candidate.referenceKey==="string" && candidate.means instanceof Float64Array && candidate.valid instanceof Uint8Array && candidate.means.length===size && candidate.valid.length===size && candidate.counts instanceof Uint32Array && candidate.counts.length===size)result=candidate;
      };
      tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=tx.onabort=()=>{db.close();resolve(null);};
    };
  }); } catch { return null; }
}
