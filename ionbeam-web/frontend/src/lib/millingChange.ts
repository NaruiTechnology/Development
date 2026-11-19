/** Exact prior-pass comparison in emitted spot order, before preview-pixel binning. */
interface SpotPass {
  coordinates: Uint32Array;
  values: Uint16Array;
  used: number;
  complete: boolean;
}
const newPass = (): SpotPass => ({coordinates:new Uint32Array(65536), values:new Uint16Array(65536),used:0,complete:false});

export function millingChangePercent(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(current-previous)*100/Math.abs(previous);
}

export function promotedMillingGray(gray: number, changePercent: number, threshold: number): number {
  return changePercent >= 0 && changePercent >= threshold ? 255 : gray;
}

export class MillingSpotChanges {
  private key: string | null = null;
  private pass = 0;
  private previous: SpotPass | null = null;
  private current: SpotPass | null = null;

  reset() { this.key=null; this.pass=0; this.previous=null; this.current=null; }

  beginPass(key: string, pass: number) {
    if (key === this.key && pass === this.pass) return;
    if (key === this.key && pass === this.pass+1 && this.current?.complete) {
      const spare = this.previous;
      this.previous = this.current;
      this.current = spare ?? newPass();
      this.current.used=0; this.current.complete=false;
    } else {
      this.previous=null; this.current=newPass();
    }
    this.key=key; this.pass=pass;
  }

  observe(x: number, y: number, value: number): number {
    const current=this.current;
    if (!current) return -1;
    const ordinal=current.used++;
    if (ordinal === current.values.length) {
      const coordinates=new Uint32Array(current.coordinates.length*2);
      const values=new Uint16Array(current.values.length*2);
      coordinates.set(current.coordinates); values.set(current.values);
      current.coordinates=coordinates; current.values=values;
    }
    const coordinate=x+y*16384;
    current.coordinates[ordinal]=coordinate; current.values[ordinal]=value;
    const previous=this.previous;
    return previous && ordinal<previous.used && previous.coordinates[ordinal]===coordinate
      ? millingChangePercent(value,previous.values[ordinal]) : -1;
  }

  completePass(key: string, pass: number) {
    if (key === this.key && pass === this.pass && this.current) this.current.complete=true;
  }
}
