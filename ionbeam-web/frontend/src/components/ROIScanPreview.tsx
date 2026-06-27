import { useEffect, useRef } from "react";

import { useAppSelector } from "../store";
import type { ROIState } from "../store/scanSlice";
import type { ROIRequest } from "../types/api";
import { ROI_CANVAS_EDGE, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";

export function ROIScanPreview({ backgroundImageUrl }: { backgroundImageUrl: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const roi = useAppSelector((s) => s.scan.roi);
  const imageSource = roi.imageDataUrl ?? backgroundImageUrl;

  useEffect(() => {
    let cancelled = false;
    if (!imageSource) {
      drawPreview(canvasRef.current, roi.selection, roi, null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (!cancelled) drawPreview(canvasRef.current, roi.selection, roi, img);
    };
    img.onerror = () => {
      if (!cancelled) drawPreview(canvasRef.current, roi.selection, roi, null);
    };
    img.src = imageSource;

    return () => {
      cancelled = true;
    };
  }, [imageSource, roi]);

  return (
    <div className="roi-mini-frame">
      <canvas
        ref={canvasRef}
        width={ROI_CANVAS_EDGE}
        height={ROI_CANVAS_EDGE}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  selection: ROIRequest | null,
  roi: Pick<
    ROIState,
    | "x_origin"
    | "x_end"
    | "y_origin"
    | "y_end"
    | "show_grid"
    | "viewport_x_start"
    | "viewport_x_end"
    | "viewport_y_start"
    | "viewport_y_end"
    | "calibration_viewport_x_start"
    | "calibration_viewport_x_end"
    | "calibration_viewport_y_start"
    | "calibration_viewport_y_end"
  >,
  image: HTMLImageElement | null
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
  ctx.fillStyle = getCssColor(canvas, "--c-bg-elev", "#11203a");
  ctx.fillRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

  if (image) {
    ctx.drawImage(image, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
  }

  if (!selection) return;

  const bounds = viewportBounds(roi);
  const x0 = worldToCanvasX(selection.x_start, roi, bounds);
  const x1 = worldToCanvasX(selection.x_end, roi, bounds);
  const y0 = worldToCanvasY(selection.y_start, roi, bounds);
  const y1 = worldToCanvasY(selection.y_end, roi, bounds);
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.max(1, Math.abs(x1 - x0));
  const height = Math.max(1, Math.abs(y1 - y0));

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fillRect(0, 0, ROI_CANVAS_EDGE, top);
  ctx.fillRect(0, top + height, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE - top - height);
  ctx.fillRect(0, top, left, height);
  ctx.fillRect(left + width, top, ROI_CANVAS_EDGE - left - width, height);

  ctx.strokeStyle = "#ff2d2d";
  ctx.lineWidth = 3;
  ctx.strokeRect(left + 1.5, top + 1.5, Math.max(1, width - 3), Math.max(1, height - 3));

  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(left + 8, top + 8, Math.max(1, width - 16), Math.max(1, height - 16));
  ctx.restore();
}

function getCssColor(el: HTMLElement, variableName: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(variableName).trim();
  return v || fallback;
}
