import type { ROIRequest, VectorScanPath } from "../types/api";
import { vectorScanSampleCount, vectorScanSamplePixel } from "./vectorScanPath.js";
import { mapScanPixelIndexToFrame, scanRegionPixelBounds } from "./scanRegions.js";

export function paintVectorScanOrderOverlay(
  canvas: HTMLCanvasElement,
  edge: number,
  cursor: number,
  scanPath: VectorScanPath,
  regions: Array<ROIRequest | null> = [null],
  clipPattern?: (ctx: CanvasRenderingContext2D) => void,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  if (edge <= 0 || cursor <= 0) return;

  const total = vectorScanSampleCount(edge, scanPath);
  // Parallel ROI samples arrive round-robin, one point per region.
  const targets = regions.length ? regions : [null];
  targets.forEach((region, regionIndex) => {
    const limit = Math.min(Math.max(0, Math.ceil((cursor - regionIndex) / targets.length)), total);
    if (limit <= 0) return;
    const bounds = scanRegionPixelBounds(region, edge);
    const pointOnCanvas = (point: { x: number; y: number }) => {
      const index = mapScanPixelIndexToFrame(bounds, edge, point.x, point.y);
      return {
        x: ((index % edge) / Math.max(1, edge - 1)) * (size - 1),
        y: (Math.floor(index / edge) / Math.max(1, edge - 1)) * (size - 1),
      };
    };
    // Clip the sweep and marker so neither can bleed outside its scanned ROI.
    ctx.save();
    clipPattern?.(ctx);
    ctx.beginPath();
    ctx.rect(bounds.x0 / edge * size, bounds.y0 / edge * size,
      (bounds.x1 - bounds.x0) / edge * size, (bounds.y1 - bounds.y0) / edge * size);
    ctx.clip();
    // Show the complete active sweep, including the part ahead of the marker.
    const first = Math.floor((limit - 1) / edge) * edge;
    const sweepEnd = Math.min(first + edge, total);
    ctx.save();
    ctx.strokeStyle = "rgba(111, 190, 211, 0.75)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let index = first; index < sweepEnd; index++) {
      const point = vectorScanSamplePixel(index, edge, scanPath);
      if (!point) continue;
      const { x, y } = pointOnCanvas(point);
      if (index === first) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    const current = vectorScanSamplePixel(limit - 1, edge, scanPath);
    if (!current) { ctx.restore(); return; }
    const { x: cx, y: cy } = pointOnCanvas(current);
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 2;
    ctx.fillStyle = "rgba(151, 210, 224, 1)";
    ctx.beginPath();
    ctx.arc(cx, cy, 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(151, 210, 224, 1)";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.3, 0, Math.PI * 2);
    ctx.moveTo(cx - 2.3, cy);
    ctx.lineTo(cx + 2.3, cy);
    ctx.moveTo(cx, cy - 2.3);
    ctx.lineTo(cx, cy + 2.3);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  });
}


/** Custom workflows traverse a sparse point list; the stream cursor is not a raster index. */
export function paintCustomVectorScanOrderOverlay(
  canvas: HTMLCanvasElement, edge: number, cursor: number, scanPath: VectorScanPath,
  points: Float32Array | null, region: ROIRequest | null,
  clipPattern?: (ctx: CanvasRenderingContext2D) => void,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!points?.length || edge <= 0 || cursor <= 0) return;
  const count = Math.floor(points.length / 2);
  const current = Math.min(count, Math.floor(cursor)) - 1;
  const fixedAxis = scanPath.startsWith("horizontal") ? 1 : 0;
  const fixed = points[2 * current + fixedAxis];
  let first = current, last = current;
  while (first > 0 && points[2 * (first - 1) + fixedAxis] === fixed) first--;
  while (last + 1 < count && points[2 * (last + 1) + fixedAxis] === fixed) last++;
  const bounds = scanRegionPixelBounds(region, edge);
  const point = (index: number) => {
    const pixel = mapScanPixelIndexToFrame(bounds, edge, points[2 * index], points[2 * index + 1]);
    return { x: (pixel % edge) / Math.max(1, edge - 1) * (canvas.width - 1),
      y: Math.floor(pixel / edge) / Math.max(1, edge - 1) * (canvas.height - 1) };
  };
  ctx.save();
  clipPattern?.(ctx);
  ctx.beginPath();
  ctx.rect(bounds.x0 / edge * canvas.width, bounds.y0 / edge * canvas.height,
    (bounds.x1 - bounds.x0) / edge * canvas.width, (bounds.y1 - bounds.y0) / edge * canvas.height);
  ctx.clip();
  ctx.strokeStyle = "rgba(111, 190, 211, 0.9)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let index = first; index <= last; index++) {
    const { x, y } = point(index);
    if (index === first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const { x, y } = point(current);
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = 2;
  ctx.fillStyle = "rgba(151, 210, 224, 1)";
  ctx.beginPath();
  ctx.arc(x, y, 1.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 2.3, y); ctx.lineTo(x + 2.3, y);
  ctx.moveTo(x, y - 2.3); ctx.lineTo(x, y + 2.3);
  ctx.stroke();
  ctx.restore();
}
