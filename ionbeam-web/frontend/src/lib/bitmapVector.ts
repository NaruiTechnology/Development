import type {
  RasterRequest,
  ROIRequest,
  SimulationBitmap,
  SimulationBitmapPixel,
  VectorRequest,
} from "../types/api";
import type { ROIState } from "../store/scanSlice";
import { ROI_CANVAS_EDGE, viewportBounds } from "./roiGeometry";

const MAX_POINTS = 250_000;
const DAC_MAX = 16383;

/**
 * Convert a world-unit ROI selection to a DAC-coded ROIRequest.
 *
 * The ROI editor's four "X origin / X end / Y origin / Y end" inputs
 * define the field-of-view (FOV) in arbitrary user units (µm, mm, cm,
 * nm). The full FOV always maps onto the full DAC range 0..16383 —
 * so `x_origin` ↔ DAC 0 and `x_end` ↔ DAC 16383. Selections inside
 * the FOV map onto a sub-range of DAC codes proportionally.
 *
 * Mapping equation (per axis):
 *
 *     fraction = (v - origin) / (end - origin)
 *     dac      = clamp(round(fraction * DAC_MAX), 0, DAC_MAX)
 *
 * Worked example: FOV is `x_origin=0, x_end=100` (µm) and the user
 * selects `x_start=25, x_end=75`. The DAC mapping is:
 *
 *     dac_start = round(25/100 * 16383) =  4096
 *     dac_end   = round(75/100 * 16383) = 12287
 *
 * — i.e. the scan covers the middle 50% of the DAC range.
 *
 * Edge handling:
 *   - Selection clamped to FOV (defensive; the UI validators already
 *     keep it inside, but the store could be initialised oddly).
 *   - `x_origin > x_end` (reversed FOV) sorted to min/max first.
 *   - `x_end == x_origin` (zero-width FOV) avoided via Math.max guard;
 *     produces dac_start=0, dac_end=DAC_MAX so the scan covers
 *     everything rather than collapsing to a point.
 *   - Resulting `x_end > x_start` guaranteed (Math.max(dx0+1, dx1));
 *     a zero-width DAC ROI would trip the Pydantic non-empty
 *     validator on the backend.
 *
 * The bitmap path keeps using the same world-unit ROI → DAC mapping;
 * calibration only changes which pixels are cropped from the source
 * image before those pixels are forwarded as `simulation_bitmap`.
 */
export function worldSelectionToDacROI(
  selection: ROIRequest,
  fov: { x_origin: number; x_end: number; y_origin: number; y_end: number }
): ROIRequest {
  // FOV bounds, sorted. Users can technically enter x_origin > x_end
  // by editing the store directly; the UI's Num validators normally
  // keep them ordered.
  const fovX0 = Math.min(fov.x_origin, fov.x_end);
  const fovX1 = Math.max(fov.x_origin, fov.x_end);
  const fovY0 = Math.min(fov.y_origin, fov.y_end);
  const fovY1 = Math.max(fov.y_origin, fov.y_end);

  // Selection corners, sorted and clamped to FOV.
  const sx0 = clampToRange(Math.min(selection.x_start, selection.x_end), fovX0, fovX1);
  const sx1 = clampToRange(Math.max(selection.x_start, selection.x_end), fovX0, fovX1);
  const sy0 = clampToRange(Math.min(selection.y_start, selection.y_end), fovY0, fovY1);
  const sy1 = clampToRange(Math.max(selection.y_start, selection.y_end), fovY0, fovY1);

  // Span = 0 means the user's FOV has no extent on this axis. In that
  // case, defaulting to the full DAC range is safer than dividing by
  // zero (which would NaN the request and 422 the backend).
  const spanX = Math.max(Number.EPSILON, fovX1 - fovX0);
  const spanY = Math.max(Number.EPSILON, fovY1 - fovY0);

  const toDac = (v: number, lo: number, span: number): number =>
    Math.max(0, Math.min(DAC_MAX, Math.round(((v - lo) / span) * DAC_MAX)));

  const dx0 = toDac(sx0, fovX0, spanX);
  const dx1 = toDac(sx1, fovX0, spanX);
  const dy0 = toDac(sy0, fovY0, spanY);
  const dy1 = toDac(sy1, fovY0, spanY);

  return {
    // Math.max(dx0 + 1, dx1) guarantees a positive-extent ROI even
    // after rounding collapses a thin selection — the Pydantic
    // ROIRequest validators reject x_start == x_end as empty.
    x_start: dx0,
    x_end:   Math.min(DAC_MAX, Math.max(dx0 + 1, dx1)),
    y_start: dy0,
    y_end:   Math.min(DAC_MAX, Math.max(dy0 + 1, dy1)),
  };
}

function clampToRange(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

let cachedExtraction:
  | {
      key: string;
      value: {
        roi: ROIRequest;
        simulationBitmap: SimulationBitmap;
      };
    }
  | null = null;

export function clearBitmapSelectionCache(): void {
  cachedExtraction = null;
}

export async function rasterRequestWithBitmapSelection(
  req: RasterRequest,
  roi: ROIState,
  options: {
    isProduction?: boolean;
    allowBitmapSimulation?: boolean;
    grayScaleSelection?: number | null;
    grayScaleSkipped?: boolean | null;
  } = {}
): Promise<RasterRequest> {
  // No selection at all → no ROI restriction, scan the full DAC range.
  if (!roi.selection) {
    return withoutBitmapROI(req);
  }

  // Selection covers the full FOV → equivalent to no ROI. Keeps the
  // backend's "no ROI" fast path (no DACCodeRange computation, no
  // per-axis stride) when the user hasn't actually picked a sub-region.
  if (!isPartialSelection(roi)) {
    return withoutBitmapROI(req);
  }

  // No bitmap loaded → use the world-unit selection and scale it into
  // DAC codes via the FOV bounds. simulation_bitmap stays null because
  // there's no image to crop.
  if (!roi.imageDataUrl) {
    return {
      ...req,
      roi: worldSelectionToDacROI(roi.selection, roi),
      simulation_bitmap: null,
    };
  }

  // Bitmap loaded with a partial selection. Only forward the cropped
  // pixels as simulation_bitmap when the active simulation source is
  // explicitly file-backed. Pattern/random simulation is configured on
  // the service/bitstream side; sending a promoted last-scan bitmap here
  // would bypass that path and make the scan complete immediately.
  if (!options.allowBitmapSimulation) {
    return {
      ...req,
      roi: worldSelectionToDacROI(roi.selection, roi),
      simulation_bitmap: null,
    };
  }

  const converted = await bitmapSelectionToVector(roi);
  if (!converted.simulationBitmap.pixels.length) {
    return withoutBitmapROI(req);
  }

  return {
    ...req,
    roi: converted.roi,
    simulation_bitmap: options.isProduction
      ? null
      : decorateSimulationBitmap(
          converted.simulationBitmap,
          options.grayScaleSelection,
          options.grayScaleSkipped,
        ),
  };
}

export async function vectorRequestWithBitmapSelection(
  req: VectorRequest,
  roi: ROIState,
  options: {
    isProduction?: boolean;
    allowBitmapSimulation?: boolean;
    grayScaleSelection?: number | null;
    grayScaleSkipped?: boolean | null;
  } = {}
): Promise<VectorRequest> {
  // No selection → no ROI; the macro sweeps the full DAC range.
  if (!roi.selection) {
    return withoutBitmapROI(req);
  }

  // Selection equals the full FOV → equivalent to no ROI.
  if (!isPartialSelection(roi)) {
    return withoutBitmapROI(req);
  }

  // No bitmap → world-unit selection → DAC ROI. The macro generates
  // the default sweep over the resulting sub-region (no custom
  // points, no simulation_bitmap).
  if (!roi.imageDataUrl) {
    return {
      ...req,
      roi: worldSelectionToDacROI(roi.selection, roi),
      simulation_bitmap: null,
    };
  }

  const converted = await bitmapSelectionToVector(roi);
  if (!converted.simulationBitmap.pixels.length) {
    return withoutBitmapROI(req);
  }

  const decoratedBitmap = decorateSimulationBitmap(
    converted.simulationBitmap,
    options.grayScaleSelection,
    options.grayScaleSkipped,
  );

  // Production vector scans can honor the gray-level selection by
  // sending only the pixels matching the selected mode as an explicit
  // point list. That keeps the beam behavior aligned with the ROI
  // highlight mask and the selected skip/splash mode.
  if (
    options.isProduction &&
    options.grayScaleSelection !== null &&
    options.grayScaleSkipped !== null
  ) {
    return {
      ...req,
      pattern: "custom",
      points: bitmapToCustomPoints(
        decoratedBitmap,
        converted.roi,
        req.dwell,
        options.grayScaleSkipped,
      ),
      roi: converted.roi,
      simulation_bitmap: null,
    };
  }

  // Bitmap path: keep vector scans as default-pattern ROI sweeps. The
  // cropped grayscale pixels are only a simulation input, and only when
  // the active simulation source is file-backed. Otherwise a promoted
  // last-scan image would override pattern/random simulation settings.
  if (!options.allowBitmapSimulation) {
    return {
      ...req,
      pattern: "default",
      points: null,
      roi: worldSelectionToDacROI(roi.selection, roi),
      simulation_bitmap: null,
    };
  }

  return {
    ...req,
    pattern: "default",
    points: null,
    roi: converted.roi,
    simulation_bitmap: options.isProduction ? null : decoratedBitmap,
  };
}

export async function grayScaleSpectrumLevelsForSelection(
  roi: ROIState
): Promise<number[]> {
  const converted = await bitmapSelectionToVector(roi);
  if (!converted.simulationBitmap.pixels.length) {
    return [];
  }

  const unique = new Set<number>();
  for (const pixel of converted.simulationBitmap.pixels) {
    unique.add(pixelValue(pixel));
  }

  return [...unique].sort((a, b) => a - b);
}

function withoutBitmapROI<T extends RasterRequest | VectorRequest>(req: T): T {
  return {
    ...req,
    roi: null,
    simulation_bitmap: null,
  };
}

async function bitmapSelectionToVector(
  roi: ROIState
): Promise<{
  roi: ROIRequest;
  simulationBitmap: SimulationBitmap;
}> {
  if (!roi.imageDataUrl || !roi.selection) {
    return emptyConversion();
  }

  const key = extractionKey(roi);
  if (cachedExtraction?.key === key) {
    return cachedExtraction.value;
  }

  const img = await loadImage(roi.imageDataUrl);
  const sourceW = img.naturalWidth || img.width;
  const sourceH = img.naturalHeight || img.height;
  if (sourceW <= 0 || sourceH <= 0) return emptyConversion();

  const crop = selectionCrop(roi, sourceW, sourceH);
  if (crop.w <= 0 || crop.h <= 0) return emptyConversion();

  const scale = Math.max(1, Math.sqrt((crop.w * crop.h) / MAX_POINTS));
  const sampleW = Math.max(1, Math.floor(crop.w / scale));
  const sampleH = Math.max(1, Math.floor(crop.h / scale));

  const canvas = document.createElement("canvas");
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return emptyConversion();

  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.w,
    crop.h,
    0,
    0,
    sampleW,
    sampleH
  );

  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  const pixels: SimulationBitmapPixel[] = [];
  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const i = (y * sampleW + x) * 4;
      const alpha = data[i + 3];
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const pixel = alpha === 0 ? 255 : Math.round(luma);
      pixels.push({ value: pixel, isHighlighted: false });
    }
  }

  const value = {
    roi: worldSelectionToDacROI(roi.selection, roi),
    simulationBitmap: {
      width: sampleW,
      height: sampleH,
      pixels,
    },
  };
  cachedExtraction = { key, value };
  return value;
}

function decorateSimulationBitmap(
  bitmap: SimulationBitmap,
  selection: number | null | undefined,
  skipped: boolean | null | undefined,
): SimulationBitmap {
  const normalizedSelection = selection === null || selection === undefined
    ? null
    : clampGrayScale(selection);
  const normalizedSkipped = skipped === null || skipped === undefined
    ? null
    : Boolean(skipped);

  if (normalizedSelection === null) {
    return {
      ...bitmap,
      pixels: bitmap.pixels.map((pixel) => ({
        value: pixelValue(pixel),
        isHighlighted: false,
        isSkipped: null,
      })),
    };
  }

  return {
    ...bitmap,
    pixels: bitmap.pixels.map((pixel) => {
      const value = pixelValue(pixel);
      const highlighted = value === normalizedSelection;
      return {
        value,
        isHighlighted: highlighted,
        isSkipped: highlighted ? normalizedSkipped : null,
      };
    }),
  };
}

function bitmapToCustomPoints(
  bitmap: SimulationBitmap,
  roi: ROIRequest,
  dwell: number,
  skipped: boolean | null | undefined,
): Array<[number, number, number]> {
  if (!bitmap.pixels.length || bitmap.width <= 0 || bitmap.height <= 0) {
    return [];
  }

  const x0 = Math.min(roi.x_start, roi.x_end);
  const x1 = Math.max(roi.x_start, roi.x_end);
  const y0 = Math.min(roi.y_start, roi.y_end);
  const y1 = Math.max(roi.y_start, roi.y_end);
  const xSpan = Math.max(1, x1 - x0);
  const ySpan = Math.max(1, y1 - y0);
  const xDiv = Math.max(1, bitmap.width - 1);
  const yDiv = Math.max(1, bitmap.height - 1);
  const normalizedSkipped = skipped === null || skipped === undefined
    ? null
    : Boolean(skipped);
  const pts: Array<[number, number, number]> = [];

  for (let y = 0; y < bitmap.height; y++) {
    const sampleY = y0 + Math.round((y / yDiv) * ySpan);
    for (let x = 0; x < bitmap.width; x++) {
      const pixel = bitmap.pixels[y * bitmap.width + x];
      const highlighted = Boolean(pixel?.isHighlighted);
      const pixelSkipped = pixel?.isSkipped === null || pixel?.isSkipped === undefined
        ? null
        : Boolean(pixel.isSkipped);
      if (normalizedSkipped === true) {
        if (highlighted && pixelSkipped !== false) continue;
      } else if (normalizedSkipped === false) {
        if (!highlighted || pixelSkipped === true) continue;
      }
      const sampleX = x0 + Math.round((x / xDiv) * xSpan);
      pts.push([sampleX, sampleY, dwell]);
    }
  }

  return pts;
}

function selectionCrop(
  roi: ROIState,
  sourceW: number,
  sourceH: number
): { x: number; y: number; w: number; h: number } {
  const sel = roi.selection!;
  const x0 = Math.min(roi.x_origin, roi.x_end);
  const x1 = Math.max(roi.x_origin, roi.x_end);
  const y0 = Math.min(roi.y_origin, roi.y_end);
  const y1 = Math.max(roi.y_origin, roi.y_end);
  const sx0 = Math.min(sel.x_start, sel.x_end);
  const sx1 = Math.max(sel.x_start, sel.x_end);
  const sy0 = Math.min(sel.y_start, sel.y_end);
  const sy1 = Math.max(sel.y_start, sel.y_end);
  const bounds = viewportBounds(roi);

  const left = clamp01((sx0 - x0) / Math.max(1, x1 - x0));
  const right = clamp01((sx1 - x0) / Math.max(1, x1 - x0));
  const top = clamp01((sy0 - y0) / Math.max(1, y1 - y0));
  const bottom = clamp01((sy1 - y0) / Math.max(1, y1 - y0));

  const px0 = Math.max(
    0,
    Math.min(
      sourceW - 1,
      Math.floor(((bounds.left + left * bounds.width) / ROI_CANVAS_EDGE) * sourceW)
    )
  );
  const px1 = Math.max(
    px0 + 1,
    Math.min(
      sourceW,
      Math.ceil(((bounds.left + right * bounds.width) / ROI_CANVAS_EDGE) * sourceW)
    )
  );
  const py0 = Math.max(
    0,
    Math.min(
      sourceH - 1,
      Math.floor(((bounds.top + top * bounds.height) / ROI_CANVAS_EDGE) * sourceH)
    )
  );
  const py1 = Math.max(
    py0 + 1,
    Math.min(
      sourceH,
      Math.ceil(((bounds.top + bottom * bounds.height) / ROI_CANVAS_EDGE) * sourceH)
    )
  );

  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
}

function isPartialSelection(roi: ROIState): boolean {
  const sel = roi.selection;
  if (!sel) return false;

  const x0 = Math.min(roi.x_origin, roi.x_end);
  const x1 = Math.max(roi.x_origin, roi.x_end);
  const y0 = Math.min(roi.y_origin, roi.y_end);
  const y1 = Math.max(roi.y_origin, roi.y_end);
  const sx0 = Math.min(sel.x_start, sel.x_end);
  const sx1 = Math.max(sel.x_start, sel.x_end);
  const sy0 = Math.min(sel.y_start, sel.y_end);
  const sy1 = Math.max(sel.y_start, sel.y_end);

  return sx0 > x0 || sx1 < x1 || sy0 > y0 || sy1 < y1;
}

function extractionKey(roi: ROIState): string {
  const r = roi.selection;
  return JSON.stringify({
    imageDataUrl: roi.imageDataUrl,
    x_origin: roi.x_origin,
    x_end: roi.x_end,
    y_origin: roi.y_origin,
    y_end: roi.y_end,
    viewport_x_start: roi.viewport_x_start,
    viewport_x_end: roi.viewport_x_end,
    viewport_y_start: roi.viewport_y_start,
    viewport_y_end: roi.viewport_y_end,
    selection: r
      ? {
          x_start: r.x_start,
          x_end: r.x_end,
          y_start: r.y_start,
          y_end: r.y_end,
        }
      : null,
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load ROI bitmap"));
    img.src = src;
  });
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function emptyConversion(): {
  roi: ROIRequest;
  simulationBitmap: SimulationBitmap;
} {
  return {
    roi: { x_start: 0, x_end: 1, y_start: 0, y_end: 1 },
    simulationBitmap: { width: 0, height: 0, pixels: [] },
  };
}

function pixelValue(pixel: number | SimulationBitmapPixel): number {
  return typeof pixel === "number" ? pixel : pixel.value;
}

function clampGrayScale(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
