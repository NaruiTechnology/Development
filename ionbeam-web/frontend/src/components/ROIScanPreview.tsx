import { useEffect, useRef, useState } from "react";

import { useLevelSetting } from "../hooks/useLevelSetting";
import type { LevelHistogram, ResolvedLevels } from "../lib/displayLevels";
import { ROI_LEVEL_KEY, applyLevelsToCanvas, measureGrayImage, resolveRoiLevels } from "../lib/grayImageLevels";

import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import type { ROIState } from "../store/scanSlice";
import type { ROIRequest } from "../types/api";
import { Icon } from "./Icon";
import {
  imageWorldBounds,
  ROI_CANVAS_EDGE,
  viewportBounds,
  worldToCanvasX,
  worldToCanvasY,
} from "../lib/roiGeometry";

const ROI_PREVIEW_ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20] as const;
const ROI_PREVIEW_DEFAULT_ZOOM_INDEX = 2;

export function ROIScanPreview({ backgroundImageUrl }: { backgroundImageUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const roi = useAppSelector((s) => s.scan.roi);
  const { t } = useTranslation();
  const [zoomIndex, setZoomIndex] = useState(ROI_PREVIEW_DEFAULT_ZOOM_INDEX);
  // Same black/white levels as the ROI canvas (shared wedge setting).
  const [levelSetting] = useLevelSetting(ROI_LEVEL_KEY);
  const zoom = ROI_PREVIEW_ZOOM_LEVELS[zoomIndex];
  const imageSource =
    roi.scanImageDataUrl ?? (roi.imageKind === "lastScan"
      ? backgroundImageUrl ?? roi.imageDataUrl
      : roi.imageDataUrl ?? backgroundImageUrl);

  useEffect(() => {
    let cancelled = false;
    if (!imageSource) {
      drawPreview(canvasRef.current, roi.selection, roi, null, null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const levels = resolveRoiLevels(histogramFor(imageSource, img), levelSetting);
      drawPreview(canvasRef.current, roi.selection, roi, img, levels);
    };
    img.onerror = () => {
      if (!cancelled) drawPreview(canvasRef.current, roi.selection, roi, null, null);
    };
    img.src = imageSource;

    return () => {
      cancelled = true;
    };
  }, [imageSource, roi, levelSetting]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (zoom <= 1) {
      frame.scrollLeft = 0;
      frame.scrollTop = 0;
      return;
    }
    const animationFrame = requestAnimationFrame(() => {
      frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
      frame.scrollTop = (frame.scrollHeight - frame.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [zoom]);

  return (
    <div className="roi-mini-preview">
      <div ref={frameRef} className="roi-mini-frame" data-zoomed={zoom > 1 ? "true" : "false"}>
        <canvas
          ref={canvasRef}
          width={ROI_CANVAS_EDGE}
          height={ROI_CANVAS_EDGE}
          style={{ width: `${zoom * 100}%` }}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        />
      </div>
      <div className="roi-mini-zoom-controls" role="group" aria-label={t("roi.preview.zoomControls")}>
        <button
          type="button"
          className="btn btn--ghost roi-mini-zoom-button"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
          aria-label={t("roi.preview.zoomOut")}
          title={t("roi.preview.zoomOut")}
        >
          <Icon name="zoomOut" />
        </button>
        <output className="roi-mini-zoom-value" aria-live="polite">
          {Math.round(zoom * 100)}%
        </output>
        <button
          type="button"
          className="btn btn--ghost roi-mini-zoom-button"
          disabled={zoomIndex === ROI_PREVIEW_ZOOM_LEVELS.length - 1}
          onClick={() => setZoomIndex((current) => Math.min(ROI_PREVIEW_ZOOM_LEVELS.length - 1, current + 1))}
          aria-label={t("roi.preview.zoomIn")}
          title={t("roi.preview.zoomIn")}
        >
          <Icon name="zoomIn" />
        </button>
      </div>
    </div>
  );
}

// The histogram only depends on the image, so keep the last one instead of
// re-measuring on every selection change.
let histogramCache: { source: string; histogram: LevelHistogram | null } | null = null;

function histogramFor(source: string, img: HTMLImageElement): LevelHistogram | null {
  if (histogramCache?.source === source) return histogramCache.histogram;
  const histogram = measureGrayImage(img)?.histogram ?? null;
  histogramCache = { source, histogram };
  return histogram;
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  selection: ROIRequest | null,
  roi: ROIState,
  image: HTMLImageElement | null,
  levels: ResolvedLevels | null,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
  ctx.fillStyle = getCssColor(canvas, "--c-bg-elev", "#11203a");
  ctx.fillRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

  const bounds = viewportBounds(roi);
  const imageBounds = imageWorldBounds(roi);
  ctx.imageSmoothingEnabled = false;

  if (image) {
    ctx.drawImage(image, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    if (levels) applyLevelsToCanvas(canvas, levels);
  }

  if (!selection) {
    return;
  }

  const x0 = worldToCanvasX(selection.x_start, imageBounds, bounds);
  const x1 = worldToCanvasX(selection.x_end, imageBounds, bounds);
  const y0 = worldToCanvasY(selection.y_start, imageBounds, bounds);
  const y1 = worldToCanvasY(selection.y_end, imageBounds, bounds);
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.max(1, Math.abs(x1 - x0));
  const height = Math.max(1, Math.abs(y1 - y0));

  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fillRect(0, 0, ROI_CANVAS_EDGE, top);
  ctx.fillRect(0, top + height, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE - top - height);
  ctx.fillRect(0, top, left, height);
  ctx.fillRect(left + width, top, ROI_CANVAS_EDGE - left - width, height);

  ctx.strokeStyle = "#ff2d2d";
  ctx.lineWidth = 0.75;
  ctx.strokeRect(left + 1.5, top + 1.5, Math.max(1, width - 3), Math.max(1, height - 3));

  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 0.5;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(left + 8, top + 8, Math.max(1, width - 16), Math.max(1, height - 16));
}

function getCssColor(el: HTMLElement, variableName: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(variableName).trim();
  return v || fallback;
}
