/**
 * Canvas glue for the ROI views' display levels (wedge).
 *
 * The ROI canvas and the small ROI preview show the same rendered 8-bit gray
 * image. Both derive their black/white levels from the same measurement of
 * that image, so automatic levels look identical in both places.
 */
import {
  ROI_GRAY_FULL_SCALE,
  applyGrayLut,
  grayHistogram,
  grayLevelLut,
  isIdentityLut,
  resolveLevels,
  type LevelHistogram,
  type LevelSetting,
  type ResolvedLevels,
} from "./displayLevels";
import { ROI_CANVAS_EDGE } from "./roiGeometry";

/** Key of the shared setting in lib/levelStore. */
export const ROI_LEVEL_KEY = "roi";

/**
 * Draw `img` at ROI canvas size into `target` (a scratch canvas is created when
 * omitted) and return the histogram of its gray pixels. `target` keeps the
 * untouched image so callers can read the raw gray values later.
 */
export function measureGrayImage(
  img: HTMLImageElement,
  target?: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; histogram: LevelHistogram } | null {
  const canvas = target ?? document.createElement("canvas");
  if (canvas.width !== ROI_CANVAS_EDGE) canvas.width = ROI_CANVAS_EDGE;
  if (canvas.height !== ROI_CANVAS_EDGE) canvas.height = ROI_CANVAS_EDGE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
  ctx.drawImage(img, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
  const rgba = ctx.getImageData(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE).data;
  return { canvas, histogram: grayHistogram(rgba) };
}

export function resolveRoiLevels(histogram: LevelHistogram | null, setting: LevelSetting): ResolvedLevels {
  if (!histogram) return resolveLevels({ min: 0, max: 0, total: 0, bins: new Uint32Array(1) }, setting, ROI_GRAY_FULL_SCALE);
  return resolveLevels(histogram, setting, ROI_GRAY_FULL_SCALE);
}

/** Restretch the gray pixels of the whole canvas in place (no-op for identity levels). */
export function applyLevelsToCanvas(canvas: HTMLCanvasElement, levels: ResolvedLevels): void {
  const lut = grayLevelLut(levels);
  if (isIdentityLut(lut)) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyGrayLut(image.data, lut);
  ctx.putImageData(image, 0, 0);
}
