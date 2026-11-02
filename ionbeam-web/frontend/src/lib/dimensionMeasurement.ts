/** Convert a known feature length into the full canvas field length. */
export function measuredFieldSpan(length: number, pixels: number, canvasEdge = 640): number {
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(pixels) || pixels < 1 || pixels > canvasEdge) {
    throw new Error("Enter a positive length and draw a measurement of at least one canvas pixel.");
  }
  return length * canvasEdge / pixels;
}
