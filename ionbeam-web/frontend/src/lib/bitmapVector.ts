import type {
  RasterRequest,
  ROIRequest,
  SimulationBitmap,
  VectorRequest,
} from "../types/api";
import type { ROIState } from "../store/scanSlice";

const MAX_POINTS = 250_000;
const DAC_MAX = 16383;

let cachedExtraction:
  | {
      key: string;
      value: {
        roi: ROIRequest;
        simulationBitmap: SimulationBitmap;
      };
    }
  | null = null;

export async function rasterRequestWithBitmapSelection(
  req: RasterRequest,
  roi: ROIState
): Promise<RasterRequest> {
  if (!roi.imageDataUrl || !roi.selection || !isPartialSelection(roi)) {
    return req;
  }

  const converted = await bitmapSelectionToVector(roi);
  if (!converted.simulationBitmap.pixels.length) {
    return req;
  }

  return {
    ...req,
    roi: converted.roi,
    simulation_bitmap: converted.simulationBitmap,
  };
}

export async function vectorRequestWithBitmapSelection(
  req: VectorRequest,
  roi: ROIState
): Promise<VectorRequest> {
  if (!roi.imageDataUrl || !roi.selection || !isPartialSelection(roi)) {
    return req;
  }

  const converted = await bitmapSelectionToVector(roi);
  if (!converted.simulationBitmap.pixels.length) {
    return req;
  }

  return {
    ...req,
    pattern: "custom",
    points: null,
    roi: converted.roi,
    simulation_bitmap: converted.simulationBitmap,
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
  const pixels: number[] = [];
  const dacRoi = cropToDacROI(crop, sourceW, sourceH);

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const i = (y * sampleW + x) * 4;
      const alpha = data[i + 3];
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const pixel = alpha === 0 ? 255 : Math.round(luma);
      pixels.push(pixel);
    }
  }

  const value = {
    roi: dacRoi,
    simulationBitmap: {
      width: sampleW,
      height: sampleH,
      pixels,
    },
  };
  cachedExtraction = { key, value };
  return value;
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

  const left = clamp01((sx0 - x0) / Math.max(1, x1 - x0));
  const right = clamp01((sx1 - x0) / Math.max(1, x1 - x0));
  const top = clamp01((sy0 - y0) / Math.max(1, y1 - y0));
  const bottom = clamp01((sy1 - y0) / Math.max(1, y1 - y0));

  const px0 = Math.max(0, Math.min(sourceW - 1, Math.floor(left * sourceW)));
  const px1 = Math.max(px0 + 1, Math.min(sourceW, Math.ceil(right * sourceW)));
  const py0 = Math.max(0, Math.min(sourceH - 1, Math.floor(top * sourceH)));
  const py1 = Math.max(py0 + 1, Math.min(sourceH, Math.ceil(bottom * sourceH)));

  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
}

function cropToDacROI(
  crop: { x: number; y: number; w: number; h: number },
  sourceW: number,
  sourceH: number
): ROIRequest {
  const x0 = Math.round((crop.x / Math.max(1, sourceW - 1)) * DAC_MAX);
  const x1 = Math.round(((crop.x + crop.w - 1) / Math.max(1, sourceW - 1)) * DAC_MAX);
  const y0 = Math.round((crop.y / Math.max(1, sourceH - 1)) * DAC_MAX);
  const y1 = Math.round(((crop.y + crop.h - 1) / Math.max(1, sourceH - 1)) * DAC_MAX);

  return {
    x_start: Math.max(0, Math.min(DAC_MAX, x0)),
    x_end: Math.max(0, Math.min(DAC_MAX, Math.max(x0 + 1, x1))),
    y_start: Math.max(0, Math.min(DAC_MAX, y0)),
    y_end: Math.max(0, Math.min(DAC_MAX, Math.max(y0 + 1, y1))),
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
  return JSON.stringify({
    imageDataUrl: roi.imageDataUrl,
    x_origin: roi.x_origin,
    x_end: roi.x_end,
    y_origin: roi.y_origin,
    y_end: roi.y_end,
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
