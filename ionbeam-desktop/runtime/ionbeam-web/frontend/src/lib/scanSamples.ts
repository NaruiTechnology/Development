/** Decode scan samples into the OBI-aligned uint16 scale used by the canvas. */

export const OBI_SCAN_FULL_SCALE = 0xfffc;

/**
 * Map an OBI sample to display gray. Supplying a measured frame range gives
 * the same live contrast behavior as OBI's histogram levels; omitting it
 * retains the absolute 0..0xfffc mapping used by gray-selection controls.
 */
export function scaleScanSample(
  value: number,
  low = 0,
  high = OBI_SCAN_FULL_SCALE,
): number {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    low = 0;
    high = OBI_SCAN_FULL_SCALE;
  }
  const clamped = Math.max(low, Math.min(high, value));
  return Math.round(((clamped - low) * 255) / (high - low));
}

/**
 * Decode a native desktop sample payload.
 *
 * SixteenBit is already little-endian uint16 on the Linux x64 desktop. EightBit contains the high byte of
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

  if (buf.byteLength % 2) throw new Error("Truncated native sample word");
  return new Uint16Array(buf);
}
