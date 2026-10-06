/**
 * One entry of the scan-parameter chip drawn on the live image after a scan
 * completes. Labels (and enum-like values) are i18n keys so the chip follows
 * the UI language; numeric values are pre-formatted strings.
 */
export interface ScanParamItem {
  id: string;
  labelKey: string;
  value?: string;
  /** Translate this key instead of showing `value` (e.g. scan path names). */
  valueKey?: string;
  /** Plain suffix appended after the translated value. */
  suffix?: string;
}

export interface ScanParamSummary {
  kind: "raster" | "vector";
  items: ScanParamItem[];
}

/** The request fields the chip reads; both RasterRequest and VectorRequest fit. */
export interface ScanParamSource {
  resolution?: number;
  vector_resolution?: number;
  pattern?: string;
  scan_path?: string;
  points?: unknown[] | null;
  simulation_bitmap?: { width: number; height: number } | null;
  dwell?: number;
  latency_bytes?: number;
  output_mode?: string;
  frame_blank?: boolean;
  feedback_mode?: string;
  gray_level_range?: [number, number] | null;
  gray_level_skipped?: boolean | null;
}

/** One ADC conversion on the current revC3 gateware (see lib/scanTiming). */
export const DEFAULT_SAMPLE_PERIOD_NS = 125;

/** A dwell of N averages N + 1 ADC samples of `samplePeriodNs` each. */
export function formatPixelDwell(dwell: number, samplePeriodNs = DEFAULT_SAMPLE_PERIOD_NS): string {
  const pixelDwellNs = (Math.max(0, Math.trunc(dwell)) + 1) * samplePeriodNs;
  return pixelDwellNs >= 1000
    ? `${(pixelDwellNs / 1000).toFixed(pixelDwellNs >= 100_000 ? 0 : 2)} µs/px`
    : `${pixelDwellNs.toFixed(1)} ns/px`;
}

/**
 * Summarise the request a scan was started with. Called when the scan
 * starts, so later edits to the form do not change the chip of a finished
 * scan. Never keeps the request itself (custom vector points can be large).
 */
export function summarizeScanParams(
  kind: "raster" | "vector",
  req: ScanParamSource,
  options: { beamEnergyEv?: number | null; samplePeriodNs?: number } = {},
): ScanParamSummary {
  const items: ScanParamItem[] = [];
  const beamEnergy = options.beamEnergyEv;
  if (typeof beamEnergy === "number" && Number.isFinite(beamEnergy)) {
    items.push({ id: "beamEnergy", labelKey: "canvas.scanParams.beamEnergy", value: `${beamEnergy} eV` });
  }

  if (kind === "raster") {
    const res = Math.trunc(req.resolution ?? 0);
    if (res > 0) items.push({ id: "resolution", labelKey: "canvas.scanParams.resolution", value: `${res}×${res}` });
  } else if (req.pattern === "custom") {
    const bitmap = req.simulation_bitmap;
    items.push({
      id: "resolution",
      labelKey: "canvas.scanParams.resolution",
      valueKey: "canvas.scanParams.customPattern",
      suffix: Array.isArray(req.points)
        ? ` (${req.points.length.toLocaleString("en-US")})`
        : bitmap
          ? ` (${bitmap.width}×${bitmap.height})`
          : undefined,
    });
  } else {
    const edge = Math.trunc(req.vector_resolution ?? 0);
    if (edge > 0) items.push({ id: "resolution", labelKey: "canvas.scanParams.resolution", value: `${edge}×${edge}` });
    if (req.scan_path) {
      items.push({ id: "scanPath", labelKey: "canvas.scanParams.scanPath", valueKey: `vector.scanPath.${req.scan_path}` });
    }
  }

  // Custom points carry their own per-point dwell.
  if (typeof req.dwell === "number" && !(kind === "vector" && req.pattern === "custom")) {
    items.push({
      id: "dwell",
      labelKey: "canvas.scanParams.dwell",
      value: `${Math.trunc(req.dwell)} (${formatPixelDwell(req.dwell, options.samplePeriodNs)})`,
    });
  }
  if (typeof req.latency_bytes === "number") {
    items.push({ id: "latency", labelKey: "canvas.scanParams.latency", value: `${req.latency_bytes} B` });
  }
  if (req.output_mode) {
    items.push({ id: "outputMode", labelKey: "canvas.scanParams.outputMode", value: req.output_mode });
  }
  if (kind === "raster" && req.frame_blank) {
    items.push({ id: "frameBlank", labelKey: "canvas.scanParams.frameBlank", valueKey: "canvas.scanParams.on" });
  }

  if (kind === "vector" && req.gray_level_range) {
    const [lo, hi] = req.gray_level_range;
    items.push({ id: "grayRange", labelKey: "canvas.scanParams.grayRange", value: `${Math.min(lo, hi)}–${Math.max(lo, hi)}` });
    if (req.gray_level_skipped === true || req.gray_level_skipped === false) {
      items.push({
        id: "grayMode",
        labelKey: "canvas.scanParams.grayMode",
        valueKey: req.gray_level_skipped ? "roi.grayScale.confirm.mode.skip" : "roi.grayScale.confirm.mode.spot",
      });
    }
    if (req.feedback_mode === "adaptive_gray_feedback") {
      items.push({ id: "feedback", labelKey: "canvas.scanParams.feedback", valueKey: "canvas.scanParams.feedback.adaptive" });
    }
  }

  return { kind, items };
}

/* ------------------------------------------------------------------------ */
/* Burning the chip into exported PNGs                                       */
/* ------------------------------------------------------------------------ */

/** Resolves an i18n key; the caller passes its `t`. */
export type ScanParamTranslate = (key: string) => string;

/**
 * "Label value" text of every chip entry, in display order — the same text the
 * on-screen chip shows, so a burned-in figure reads exactly like the live view.
 */
export function scanParamChipSegments(items: ScanParamItem[], translate: ScanParamTranslate): string[] {
  return items.map((item) => {
    const value = `${item.valueKey ? translate(item.valueKey) : item.value ?? ""}${item.suffix ?? ""}`;
    return `${translate(item.labelKey)} ${value}`.trim();
  });
}

/**
 * Greedy word-wrap of chip segments into lines no wider than `maxWidth`.
 * A segment is never split; one wider than `maxWidth` gets its own line.
 */
export function wrapScanParamSegments(
  segments: string[],
  maxWidth: number,
  measure: (text: string) => number,
  gap = "   ",
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const segment of segments) {
    if (!segment) continue;
    const candidate = line ? `${line}${gap}${segment}` : segment;
    if (line && measure(candidate) > maxWidth) {
      lines.push(line);
      line = segment;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Smallest long edge an exported (annotated / chip-stamped) PNG is drawn at. */
export const MIN_EXPORT_EDGE = 1024;

/**
 * Integer upscale factor for exporting a `width`×`height` scan image.
 * Overlays (chip, annotation labels) have minimum legible pixel sizes, so a
 * low-resolution scan (e.g. 128×128) must be enlarged first or the text
 * covers the whole picture. An integer factor with smoothing disabled keeps
 * every scan pixel a crisp, uniform block — the data itself is unchanged.
 */
export function exportScaleFactor(width: number, height: number, minEdge = MIN_EXPORT_EDGE): number {
  const longEdge = Math.max(width, height);
  if (!(longEdge > 0) || longEdge >= minEdge) return 1;
  return Math.ceil(minEdge / longEdge);
}

function chipFontSize(width: number, height: number): number {
  // On screen the chip is 11px over a ~690px frame showing the image; keep
  // that proportion so the burned-in chip reads the same size as the overlay.
  return Math.max(11, Math.round(Math.min(width, height) * 0.016));
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Draw the scan-parameter chip over an exported image with the same "glass"
 * look and placement as the live `.canvas-scan-params` overlay (theme.css):
 * left 12 %, bottom 8 %, max 76 % wide, 6px radius, translucent navy fill,
 * faint white border, 60 % white text with a soft shadow, 0.78 opacity.
 * All metrics are scaled from the CSS 11px font to the image size.
 */
export function drawScanParamChip(
  ctx: CanvasRenderingContext2D,
  items: ScanParamItem[],
  translate: ScanParamTranslate,
  width: number,
  height: number,
): void {
  const segments = scanParamChipSegments(items, translate);
  if (!segments.length || width <= 0 || height <= 0) return;

  const fontSize = chipFontSize(width, height);
  const k = fontSize / 11; // CSS px -> image px
  const padX = 7 * k;
  const padY = 3 * k;
  const lineHeight = fontSize * 1.35;

  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const maxTextWidth = Math.max(fontSize * 4, width * 0.76 - padX * 2);
  const lines = wrapScanParamSegments(segments, maxTextWidth, (text) => ctx.measureText(text).width);
  const textWidth = Math.min(maxTextWidth, Math.max(...lines.map((l) => ctx.measureText(l).width)));
  const boxW = Math.ceil(textWidth + padX * 2);
  const boxH = Math.ceil(lines.length * lineHeight + padY * 2);
  const boxX = Math.round(width * 0.12);
  const boxY = Math.max(0, Math.round(height * 0.92) - boxH);

  roundedRectPath(ctx, boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1, 6 * k);
  ctx.fillStyle = "rgba(15, 23, 42, 0.16)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = Math.max(1, k);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 2 * k;
  lines.forEach((line, i) => {
    ctx.fillText(line, boxX + padX, boxY + padY + (i + 0.5) * lineHeight, maxTextWidth);
  });
  ctx.restore();
}

/** Decode a PNG blob / data URL, burn the glass chip into it, re-encode. */
export async function burnScanParamChip(
  source: Blob,
  items: ScanParamItem[],
  translate: ScanParamTranslate,
): Promise<Blob> {
  if (!items.length) return source;
  const url = URL.createObjectURL(source);
  try {
    const image = await loadPng(url);
    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    const scale = exportScaleFactor(srcW, srcH);
    const width = srcW * scale;
    const height = srcH * scale;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return source;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, width, height);
    drawScanParamChip(ctx, items, translate, width, height);
    return await canvasToPng(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadPng(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("figure decode failed"));
    img.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("figure encode failed"))), "image/png"),
  );
}

/**
 * Return a copy of a PNG with the scan-parameter summary added as a caption
 * band under the picture. Used for the server-rendered matplotlib figure,
 * whose title/axes/colorbar layout makes an in-image overlay unsafe.
 */
export async function appendScanParamCaption(
  png: Blob,
  items: ScanParamItem[],
  translate: ScanParamTranslate,
): Promise<Blob> {
  const segments = scanParamChipSegments(items, translate);
  if (!segments.length) return png;

  const bitmapUrl = URL.createObjectURL(png);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("figure decode failed"));
      img.src = bitmapUrl;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const fontSize = chipFontSize(width, height);
    const lineHeight = Math.round(fontSize * 1.35);
    const pad = Math.round(fontSize * 0.7);

    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) return png;
    measureCtx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    const lines = wrapScanParamSegments(segments, width - pad * 2, (t) => measureCtx.measureText(t).width);
    const bandH = lines.length * lineHeight + pad * 2;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height + bandH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return png;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.font = measureCtx.font;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#1f2937";
    lines.forEach((line, i) => ctx.fillText(line, pad, height + pad + i * lineHeight, width - pad * 2));

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("figure encode failed"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
