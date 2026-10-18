/**
 * Target gray level helpers for the ROI image canvas.
 *
 * The operator right-clicks a pixel to pick a target gray level. Action run
 * (with an ROI area and no gray level filter range) then repeatedly steps
 * every pixel inside the ROI area toward that target until they all match.
 * Pixels outside the ROI area are never touched.
 */

/** Gray levels a pixel may move toward the target in one pass. */
export const ROI_TARGET_GRAY_STEP = 2;

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Gray value of an RGB pixel. Gray pixels (R = G = B, every scan image)
 * report their channel value unchanged, matching the gray level filter;
 * colour pixels fall back to Rec. 601 luma.
 */
export function pixelGray(r: number, g: number, b: number): number {
  if (r === g && g === b) return r;
  return Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
}

/** Gray value at (x, y) of an RGBA buffer, or null outside it / on a transparent pixel. */
export function grayAt(
  data: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
): number | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= imageWidth || py >= imageHeight) return null;
  const i = (py * imageWidth + px) * 4;
  if (data[i + 3] === 0) return null;
  return pixelGray(data[i], data[i + 1], data[i + 2]);
}

/** Integer pixel rectangle clipped to the image, or null when empty. */
export function clipPixelRect(
  rect: PixelRect,
  imageWidth: number,
  imageHeight: number,
): PixelRect | null {
  const left = Math.max(0, Math.floor(rect.left));
  const top = Math.max(0, Math.floor(rect.top));
  const right = Math.min(imageWidth, Math.ceil(rect.left + rect.width));
  const bottom = Math.min(imageHeight, Math.ceil(rect.top + rect.height));
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Number of opaque pixels inside `rect` whose gray value differs from `target`. */
export function countTargetGrayMismatches(
  data: ArrayLike<number>,
  imageWidth: number,
  rect: PixelRect,
  target: number,
): number {
  let mismatches = 0;
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = (y * imageWidth + x) * 4;
      if (data[i + 3] === 0) continue;
      if (data[i] !== target || data[i + 1] !== target || data[i + 2] !== target) mismatches++;
    }
  }
  return mismatches;
}

/**
 * One pass of the target gray loop: move every opaque pixel inside `rect`
 * at most `maxStep` gray levels toward `target` (writing it back as gray),
 * in place. Returns how many pixels still differ from the target.
 */
export function stepTowardTargetGray(
  data: Uint8ClampedArray,
  imageWidth: number,
  rect: PixelRect,
  target: number,
  maxStep = ROI_TARGET_GRAY_STEP,
): number {
  const goal = Math.max(0, Math.min(255, Math.round(target)));
  const step = Math.max(1, Math.round(maxStep));
  let remaining = 0;
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = (y * imageWidth + x) * 4;
      if (data[i + 3] === 0) continue;
      const gray = pixelGray(data[i], data[i + 1], data[i + 2]);
      const delta = Math.max(-step, Math.min(step, goal - gray));
      const next = gray + delta;
      data[i] = next;
      data[i + 1] = next;
      data[i + 2] = next;
      if (next !== goal) remaining++;
    }
  }
  return remaining;
}
