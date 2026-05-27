import { useEffect, useRef } from "react";

import { useAppSelector } from "../store";
import type { ROIRequest } from "../types/api";

const EDGE = 640;

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
        width={EDGE}
        height={EDGE}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}

function drawPreview(
  canvas: HTMLCanvasElement | null,
  selection: ROIRequest | null,
  roi: {
    x_origin: number;
    x_end: number;
    y_origin: number;
    y_end: number;
    show_grid: boolean;
  },
  image: HTMLImageElement | null
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, EDGE, EDGE);
  ctx.fillStyle = getCssColor(canvas, "--c-bg-elev", "#11203a");
  ctx.fillRect(0, 0, EDGE, EDGE);

  if (image) {
    ctx.drawImage(image, 0, 0, EDGE, EDGE);
  }

  if (!selection) return;

  const x0 = dutToCanvas(selection.x_start, roi.x_origin, roi.x_end);
  const x1 = dutToCanvas(selection.x_end, roi.x_origin, roi.x_end);
  const y0 = dutToCanvas(selection.y_start, roi.y_origin, roi.y_end);
  const y1 = dutToCanvas(selection.y_end, roi.y_origin, roi.y_end);
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const width = Math.max(1, Math.abs(x1 - x0));
  const height = Math.max(1, Math.abs(y1 - y0));

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
  ctx.fillRect(0, 0, EDGE, top);
  ctx.fillRect(0, top + height, EDGE, EDGE - top - height);
  ctx.fillRect(0, top, left, height);
  ctx.fillRect(left + width, top, EDGE - left - width, height);

  ctx.strokeStyle = "#ff2d2d";
  ctx.lineWidth = 3;
  ctx.strokeRect(left + 1.5, top + 1.5, Math.max(1, width - 3), Math.max(1, height - 3));

  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(left + 8, top + 8, Math.max(1, width - 16), Math.max(1, height - 16));
  ctx.restore();
}

function dutToCanvas(v: number, start: number, end: number): number {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const span = Math.max(Number.EPSILON, hi - lo);
  const t = (v - lo) / span;
  return Math.max(0, Math.min(EDGE, Math.round(t * EDGE)));
}

function getCssColor(el: HTMLElement, variableName: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(variableName).trim();
  return v || fallback;
}
