import type {
  RasterRequest,
  ROIRequest,
  SimulationBitmap,
  SimulationBitmapPixel,
  VectorPoint,
  VectorPointTuple,
  VectorRequest,
  VectorScanPath,
} from "../types/api";
import type { ROIState } from "../store/scanSlice";
import {
  clampGrayScale,
  grayScaleSelectionContains,
  normalizeGrayScaleSelection,
  type GrayScaleSelection,
} from "./grayScaleSelection";
import { imageWorldBounds, ROI_CANVAS_EDGE, viewportBounds } from "./roiGeometry";
import { worldSelectionToDacROI } from "./roiDac";
import { bitmapScanCoordinates } from "./vectorScanPath";

export { worldSelectionToDacROI } from "./roiDac";

const MAX_POINTS = 250_000;

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
    grayScaleSelection?: GrayScaleSelection;
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
          options.grayScaleSelection ?? null,
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
    grayScaleSelection?: GrayScaleSelection;
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
      pattern: "default",
      points: null,
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
    options.grayScaleSelection ?? null,
    options.grayScaleSkipped,
  );

  // Production vector scans can honor the gray-level selection by
  // sending the cropped bitmap as an explicit point list with a per-
  // point blank flag. That lets the FPGA blank or unblank the beam at
  // each vector point instead of the host just omitting pixels.
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
        req.scan_path,
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

export async function vectorRequestWithROIGrayScaleAction(
  req: VectorRequest,
  roi: ROIState,
  options: {
    grayScaleSelection: GrayScaleSelection;
    grayScaleSkipped: boolean | null;
  }
): Promise<VectorRequest> {
  const selection = normalizeGrayScaleSelection(options.grayScaleSelection);
  if (selection === null || options.grayScaleSkipped === null) {
    return vectorRequestWithBitmapSelection(req, roi, {
      isProduction: true,
      grayScaleSelection: selection,
      grayScaleSkipped: options.grayScaleSkipped,
    });
  }

  const converted = await bitmapSelectionToVector(roiWithFullSelection(roi));
  if (!converted.simulationBitmap.pixels.length) {
    return withoutBitmapROI(req);
  }

  const decoratedBitmap = decorateSimulationBitmap(
    converted.simulationBitmap,
    selection,
    options.grayScaleSkipped,
  );
  return {
    ...req,
    pattern: "custom",
    points: bitmapToROIActionPoints(
      decoratedBitmap,
      converted.roi,
      Math.max(2, req.dwell),
      selection,
      options.grayScaleSkipped,
      req.scan_path,
    ),
    roi: converted.roi,
    simulation_bitmap: null,
    dwell: Math.max(2, req.dwell),
    gray_level_range: [selection[0], selection[1]],
    gray_level_skipped: options.grayScaleSkipped,
    // The ROI panel shows pre-process locked on for parity with the vector
    // controls, but Glasgow's pre-process path aborts explicit custom points.
    pre_process: false,
  };
}

export async function vectorRequestWithAdaptiveGrayFeedback(
  req: VectorRequest,
  roi: ROIState,
  options: {
    grayScaleSelection: GrayScaleSelection;
    grayScaleSkipped: boolean | null;
  }
): Promise<VectorRequest> {
  const selection = normalizeGrayScaleSelection(options.grayScaleSelection);
  if (selection === null || options.grayScaleSkipped === null) {
    return withoutBitmapROI(req);
  }

  const activeROI = roiWithFullSelection(roi);
  const roiSelection = activeROI.selection;
  if (!roiSelection) {
    return withoutBitmapROI(req);
  }

  const roiRequest = activeROI.imageDataUrl
    ? (await bitmapSelectionToVector(activeROI)).roi
    : worldSelectionToDacROI(roiSelection, activeROI);

  return {
    ...req,
    pattern: "default",
    points: null,
    roi: roiRequest,
    simulation_bitmap: null,
    pre_process: true,
    dwell: req.dwell,
    output_mode: "SixteenBit",
    feedback_mode: "adaptive_gray_feedback",
    gray_level_range: [selection[0], selection[1]],
    gray_level_skipped: options.grayScaleSkipped,
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
    ...(Object.prototype.hasOwnProperty.call(req, "feedback_mode")
      ? {
          feedback_mode: "standard",
          gray_level_range: null,
          gray_level_skipped: null,
        }
      : {}),
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
      pixels.push({ value: pixel, isHighlighted: false, isSkipped: null, blank: null });
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
  selection: GrayScaleSelection,
  skipped: boolean | null | undefined,
): SimulationBitmap {
  const normalizedSelection = normalizeGrayScaleSelection(selection);
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
        blank: null,
      })),
    };
  }

  return {
    ...bitmap,
    pixels: bitmap.pixels.map((pixel) => {
      const value = pixelValue(pixel);
      const highlighted = grayScaleSelectionContains(normalizedSelection, value);
      return {
        value,
        isHighlighted: highlighted,
        isSkipped: highlighted ? normalizedSkipped : null,
        blank:
          normalizedSkipped === true
            ? highlighted
            : normalizedSkipped === false
            ? !highlighted
            : null,
      };
    }),
  };
}

function bitmapToCustomPoints(
  bitmap: SimulationBitmap,
  roi: ROIRequest,
  dwell: number,
  skipped: boolean | null | undefined,
  scanPath: VectorScanPath,
): VectorPointTuple[] {
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
  const primaryPass: VectorPointTuple[] = [];
  const secondaryPass: VectorPointTuple[] = [];

  for (const [x, y] of bitmapScanCoordinates(bitmap.width, bitmap.height, scanPath)) {
    const sampleY = y0 + Math.round((y / yDiv) * ySpan);
    const pixel = bitmap.pixels[y * bitmap.width + x];
    const highlighted = Boolean(pixel?.isHighlighted);
    const sampleX = x0 + Math.round((x / xDiv) * xSpan);
    const blank = normalizedSkipped === true
      ? highlighted
      : normalizedSkipped === false
      ? !highlighted
      : false;
    const point: VectorPointTuple = [
      sampleX,
      sampleY,
      dwell,
      blank,
      normalizedSkipped === null
        ? null
        : highlighted
        ? 1
        : 2,
    ];

    // Emit the selected interval as the first pass and the complement
    // as the second pass while preserving scan-path order in each pass.
    if (
      normalizedSkipped === null ||
      (normalizedSkipped === true && highlighted) ||
      (normalizedSkipped === false && !highlighted)
    ) {
      primaryPass.push(point);
    } else {
      secondaryPass.push(point);
    }
  }

  return primaryPass.concat(secondaryPass);
}

function bitmapToROIActionPoints(
  bitmap: SimulationBitmap,
  fullRoi: ROIRequest,
  dwell: number,
  selection: [number, number],
  skipped: boolean,
  scanPath: VectorScanPath,
): VectorPointTuple[] {
  if (!bitmap.pixels.length || bitmap.width <= 0 || bitmap.height <= 0) {
    return [];
  }

  const x0 = Math.min(fullRoi.x_start, fullRoi.x_end);
  const x1 = Math.max(fullRoi.x_start, fullRoi.x_end);
  const y0 = Math.min(fullRoi.y_start, fullRoi.y_end);
  const y1 = Math.max(fullRoi.y_start, fullRoi.y_end);
  const xDiv = Math.max(1, bitmap.width - 1);
  const yDiv = Math.max(1, bitmap.height - 1);
  const xSpan = Math.max(1, x1 - x0);
  const ySpan = Math.max(1, y1 - y0);
  const points: VectorPointTuple[] = [];

  for (const [x, y] of bitmapScanCoordinates(bitmap.width, bitmap.height, scanPath)) {
    const sampleY = y0 + Math.round((y / yDiv) * ySpan);
    const sampleX = x0 + Math.round((x / xDiv) * xSpan);
    const pixel = bitmap.pixels[y * bitmap.width + x];
    const pixelBlank = typeof pixel === "number" ? null : pixel.blank ?? null;
    const highlighted = grayScaleSelectionContains(selection, pixelValue(pixel));
    const blank =
      pixelBlank !== null
        ? pixelBlank
        : skipped
        ? highlighted
        : !highlighted;
    points.push([sampleX, sampleY, dwell, blank, highlighted ? 1 : 2]);
  }

  return points;
}

function selectionCrop(
  roi: ROIState,
  sourceW: number,
  sourceH: number
): { x: number; y: number; w: number; h: number } {
  const sel = roi.selection!;
  const imageBounds = imageWorldBounds(roi);
  const x0 = Math.min(imageBounds.x_origin, imageBounds.x_end);
  const x1 = Math.max(imageBounds.x_origin, imageBounds.x_end);
  const y0 = Math.min(imageBounds.y_origin, imageBounds.y_end);
  const y1 = Math.max(imageBounds.y_origin, imageBounds.y_end);
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

function roiWithFullSelection(roi: ROIState): ROIState {
  if (roi.selection) return roi;
  const bounds = imageWorldBounds(roi);
  return {
    ...roi,
    selection: {
      x_start: Math.min(bounds.x_origin, bounds.x_end),
      x_end: Math.max(bounds.x_origin, bounds.x_end),
      y_start: Math.min(bounds.y_origin, bounds.y_end),
      y_end: Math.max(bounds.y_origin, bounds.y_end),
    },
  };
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
  const imageDataUrl = roi.imageDataUrl ?? "";
  return JSON.stringify({
    imageName: roi.imageName,
    imageKind: roi.imageKind,
    imageDataUrlLength: imageDataUrl.length,
    imageDataUrlHead: imageDataUrl.slice(0, 96),
    imageDataUrlTail: imageDataUrl.slice(-96),
    x_origin: roi.x_origin,
    x_end: roi.x_end,
    y_origin: roi.y_origin,
    y_end: roi.y_end,
    imageBounds: roi.imageBounds,
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
