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

/**
 * Beam decision for one pixel: SKIP (beam blanked) once the pixel's gray
 * value equals the target, SPOT (beam on) while it still differs. Made per
 * pixel, per pass, from the pixel's current gray value.
 */
export type TargetGrayDecision = "spot" | "skip";

export function targetGrayDecision(gray: number, target: number): TargetGrayDecision {
  return Math.round(gray) === Math.round(target) ? "skip" : "spot";
}

/**
 * The same rule as a gray level filter for the scan request: the single
 * level [target, target] with Skip = true blanks the beam on pixels at the
 * target and spots every other pixel.
 */
export function targetGrayFilter(target: number): { selection: [number, number]; skipped: true } {
  const level = Math.max(0, Math.min(255, Math.round(target)));
  return { selection: [level, level], skipped: true };
}

export interface TargetGrayPassResult {
  /** Pixels the beam spotted in this pass (gray differed from the target). */
  spot: number;
  /** Pixels the beam skipped in this pass (gray already equal to the target). */
  skip: number;
  /** Pixels still differing from the target after this pass. */
  remaining: number;
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
      const gray = pixelGray(data[i], data[i + 1], data[i + 2]);
      if (targetGrayDecision(gray, target) === "spot") mismatches++;
    }
  }
  return mismatches;
}

/**
 * One pass of the target gray loop, in place. Every opaque pixel inside
 * `rect` is compared with `target` first:
 *   - SKIP: its gray equals the target, the beam is blanked and the pixel
 *     is left unchanged;
 *   - SPOT: its gray differs, the beam dwells there and moves it at most
 *     `maxStep` gray levels toward the target.
 * When `decisions` is given, each pixel's decision is recorded there at
 * index `y * imageWidth + x` (1 = SPOT, 0 = SKIP; other entries untouched).
 */
export function stepTowardTargetGray(
  data: Uint8ClampedArray,
  imageWidth: number,
  rect: PixelRect,
  target: number,
  maxStep = ROI_TARGET_GRAY_STEP,
  decisions?: Uint8Array,
): TargetGrayPassResult {
  const goal = Math.max(0, Math.min(255, Math.round(target)));
  const step = Math.max(1, Math.round(maxStep));
  const result: TargetGrayPassResult = { spot: 0, skip: 0, remaining: 0 };
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const i = (y * imageWidth + x) * 4;
      if (data[i + 3] === 0) continue;
      const gray = pixelGray(data[i], data[i + 1], data[i + 2]);
      if (targetGrayDecision(gray, goal) === "skip") {
        result.skip++;
        if (decisions) decisions[y * imageWidth + x] = 0;
        continue;
      }
      result.spot++;
      if (decisions) decisions[y * imageWidth + x] = 1;
      const next = gray + Math.max(-step, Math.min(step, goal - gray));
      data[i] = next;
      data[i + 1] = next;
      data[i + 2] = next;
      if (next !== goal) result.remaining++;
    }
  }
  return result;
}
