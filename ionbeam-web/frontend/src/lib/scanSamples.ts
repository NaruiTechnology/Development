/** Decode scan samples into the OBI-aligned uint16 scale used by the canvas. */

export const OBI_SCAN_FULL_SCALE = 0xfffc;

/**
 * Decode a WebSocket scan payload.
 *
 * SixteenBit is already big-endian uint16. EightBit contains the high byte of
 * the OBI-aligned sample; expand it across the same 0..0xfffc display range
 * so 0xff remains full scale instead of rendering as 0xff00/0xfffc.
 */
export function decodeScanSamples(buf: ArrayBuffer, outputMode?: string): Uint16Array {
  if (outputMode === "EightBit") {
    const view = new Uint8Array(buf);
    const out = new Uint16Array(view.length);
    for (let i = 0; i < view.length; i++) {
      out[i] = Math.round((view[i] * OBI_SCAN_FULL_SCALE) / 0xff);
    }
    return out;
  }

  const view = new Uint8Array(buf);
  const n = view.length >> 1;
  const out = new Uint16Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    out[i] = (view[j] << 8) | view[j + 1];
  }
  return out;
}
