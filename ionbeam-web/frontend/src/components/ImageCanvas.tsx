/**
 * Renders the raster grayscale frame or vector ADC image onto a canvas.
 *
 * Raster and vector scans are stored as flat Uint16Array buffers and
 * rendered as auto-scaled grayscale. The hardware returns 16-bit ADC
 * samples, and real signals can live mostly below the high byte; a fixed
 * `sample >> 8` display can look blank even while data is arriving.
 *
 * For raster the buffer is populated row-major as the FPGA emits samples.
 * For vector default, samples arrive x-major/y-inner and are painted back
 * to their actual populated cells. For vector custom, only requested
 * point coordinates are painted; unpopulated cells stay transparent.
 */
import { useEffect, useRef, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import {
  setVectorRenderMode,
  type ScanKind,
  type ROIState,
  type VectorRenderMode,
} from "../store/scanSlice";
import type { ROIRequest } from "../types/api";

const DAC_RANGE = 2048;

interface PaintStats {
  min: number;
  max: number;
  populated: number;
}

export function ImageCanvas({ kind }: { kind: ScanKind }) {
  const dispatch = useAppDispatch();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<PaintStats>({ min: 0, max: 0, populated: 0 });
  const [serverFigureUrl, setServerFigureUrl] = useState<string | null>(null);
  const [serverFigureBusy, setServerFigureBusy] = useState(false);
  const [serverFigureError, setServerFigureError] = useState<string | null>(null);

  const revision = useAppSelector((s) => s.image.revision);

  // Raster fields
  const resolution = useAppSelector((s) => s.image.resolution);
  const frame = useAppSelector((s) => s.image.frame);
  const cursor = useAppSelector((s) => s.image.cursor);

  // Vector fields
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorCustomPoints = useAppSelector((s) => s.image.vectorCustomPoints);
  const vectorCustomRenderPoints = useAppSelector((s) => s.image.vectorCustomRenderPoints);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorPattern = useAppSelector((s) => s.image.vectorPattern);
  const vectorCustomCount = useAppSelector((s) => s.image.vectorCustomCount);
  const renderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const roi = useAppSelector((s) => s.scan.roi);

  const phase = useAppSelector((s) => s.scan.phase);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);
  const showServerFigure = phase === "completed" || phase === "paused";

  // Render-mode picker shows only for vector + default pattern. In
  // custom mode the buffer is already 2048-wide and "decimated" doesn't
  // mean anything; the toggle stays hidden to avoid confusion.
  const showModeToggle = kind === "vector" && vectorPattern === "default";

  // Native-mode block-fill stride. Only meaningful for default pattern;
  // custom always paints at 1:1 since coordinates are already DAC codes.
  const stride =
    kind === "vector" && vectorPattern === "default" && vectorEdge > 0
      ? Math.max(1, Math.floor(DAC_RANGE / vectorEdge))
      : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (kind === "raster") {
      const s = paintGrayscale(canvas, frame, resolution, cursor);
      setStats(s);
    } else if (kind === "vector" && vectorPattern === "default" && renderMode === "native" && stride > 1) {
      // Block-fill into a 2048x2048 canvas. Each buffer cell paints a
      // stride x stride square. For stride==1 this is identical to
      // decimated, so we fall through to the dense-paint path.
      const s = paintVectorDefaultBlockFill(canvas, vectorImage, vectorEdge, vectorCursor, stride);
      setStats(s);
    } else if (kind === "vector" && vectorPattern === "default") {
      const s = paintVectorDefault(canvas, vectorImage, vectorEdge, vectorCursor);
      setStats(s);
    } else if (kind === "vector" && vectorCustomRenderPoints) {
      const s = paintVectorCustom(canvas, vectorImage, vectorEdge, vectorCustomRenderPoints, vectorCursor);
      setStats(s);
    } else {
      // Empty custom-vector setup, before points have been loaded.
      const s = paintGrayscale(canvas, vectorImage, vectorEdge, vectorCursor);
      setStats(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, kind, renderMode]);

  useEffect(() => {
    if (!showServerFigure) {
      setServerFigureUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setServerFigureBusy(false);
      setServerFigureError(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setServerFigureBusy(true);
    setServerFigureError(null);

    const url =
      kind === "vector"
        ? `/api/scan/last/figure?render=${encodeURIComponent(renderMode)}&view=texture`
        : "/api/scan/last/figure?view=texture";

    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setServerFigureUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      })
      .catch((e: any) => {
        if (!cancelled) {
          setServerFigureUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
          setServerFigureError(e?.message ?? String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setServerFigureBusy(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [showServerFigure, kind, renderMode, chunksReceived]);

  const totalRasterPx = resolution * resolution;
  const totalVectorSamples =
    vectorPattern === "default" ? vectorEdge * vectorEdge : vectorCustomCount;
  const activeRegion = activeROIRegion(roi);
  const current = currentBeamPosition({
    kind,
    roi,
    region: activeRegion,
    rasterFrame: frame,
    rasterResolution: resolution,
    rasterCursor: cursor,
    vectorImage,
    vectorEdge,
    vectorCursor,
    vectorPattern,
    vectorCustomPoints,
    vectorCustomRenderPoints,
  });

  const pct =
    kind === "raster" && totalRasterPx > 0
      ? Math.min(100, (cursor / totalRasterPx) * 100)
      : kind === "vector" && totalVectorSamples > 0
      ? Math.min(100, (vectorCursor / totalVectorSamples) * 100)
      : phase === "completed"
      ? 100
      : 0;

  // Canvas native size depends on mode for vector:
  //   raster:                                 resolution
  //   vector decimated, or default stride==1: vectorEdge
  //   vector native (default with stride>1):  DAC_RANGE
  let nativeEdge: number;
  if (kind === "raster") {
    nativeEdge = resolution;
  } else if (vectorPattern === "default" && renderMode === "native" && stride > 1) {
    nativeEdge = DAC_RANGE;
  } else {
    nativeEdge = vectorEdge;
  }
  const canvasSize = Math.min(
    nativeEdge * Math.max(1, Math.floor(640 / nativeEdge)),
    768
  );

  return (
    <div>
      {showModeToggle && (
        <div className="row" style={{ marginBottom: 10, gap: 8 }}>
          <span className="card__title" id="render-mode-label">View</span>
          <div
            className="segmented"
            role="radiogroup"
            aria-labelledby="render-mode-label"
          >
            {(["decimated", "native"] as VectorRenderMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={renderMode === m}
                aria-pressed={renderMode === m}
                className="segmented__btn"
                title={
                  m === "decimated"
                    ? `Dense ${vectorEdge}×${vectorEdge} image — pixels = sample indices`
                    : `Native ${DAC_RANGE}×${DAC_RANGE} with stride ${stride} block-fill — pixels = DAC codes`
                }
                onClick={() => dispatch(setVectorRenderMode(m))}
              >
                {m === "decimated"
                  ? `Decimated (${vectorEdge}×${vectorEdge})`
                  : `Native (${DAC_RANGE}×${DAC_RANGE})`}
              </button>
            ))}
          </div>
          {stride === 1 && (
            <span className="muted" style={{ fontSize: 11 }}>
              stride 1 — both views are identical
            </span>
          )}
        </div>
      )}

      <div className="canvas-frame">
        {serverFigureUrl ? (
          <img
            className="server-figure"
            src={serverFigureUrl}
            alt={`${kind} scan rendered by glasgow_service`}
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={nativeEdge}
            height={nativeEdge}
            style={{ width: canvasSize, height: canvasSize }}
          />
        )}
      </div>

      {showServerFigure && !serverFigureUrl && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {serverFigureBusy
            ? "Rendering server figure..."
            : serverFigureError
            ? `Server figure unavailable: ${serverFigureError}`
            : "Using live preview."}
        </div>
      )}

      <div className="progress" style={{ marginTop: 10 }}>
        <span style={{ width: `${pct}%` }} />
      </div>

      <div className="canvas-meta">
        <span>
          phase <b>{phase}</b>
        </span>
        <span>
          chunks <b>{chunksReceived.toLocaleString()}</b>
        </span>
        <span>
          bytes <b>{bytesReceived.toLocaleString()}</b>
        </span>
        <span>
          resolution <b>{nativeEdge.toLocaleString()}×{nativeEdge.toLocaleString()}</b>
        </span>
        {kind === "raster" ? (
          <>
            <span>
              pixels{" "}
              <b>
                {cursor.toLocaleString()} / {totalRasterPx.toLocaleString()}
              </b>
            </span>
          </>
        ) : (
          <>
            <span>
              samples{" "}
              <b>
                {vectorCursor.toLocaleString()}
                {totalVectorSamples > 0
                  ? ` / ${totalVectorSamples.toLocaleString()}`
                  : ""}
              </b>
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              {vectorPattern}
              {vectorPattern === "default" && ` ${vectorEdge}×${vectorEdge}`}
            </span>
          </>
        )}
        <span title="Active 2-D DUT-mapped scan region from the ROI editor.">
          ROI{" "}
          <b>
            {formatPoint(activeRegion.x_start, activeRegion.y_start, roi.scale_unit)} →{" "}
            {formatPoint(activeRegion.x_end, activeRegion.y_end, roi.scale_unit)}
          </b>
        </span>
        {current && (
          <span title="Current beam position derived from the latest received ADC sample index.">
            beam <b>{formatPoint(current.x, current.y, roi.scale_unit)}</b>
          </span>
        )}
        {current && (
          <span title="ADC value at the current beam position.">
            ADC now <b>{current.adc}</b>
          </span>
        )}
        {stats.populated > 0 && (
          <span title="Raw ADC range in the received samples. Canvas auto-scales this range into visible grayscale.">
            ADC <b>{stats.min}..{stats.max}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* -------- scan metadata helpers --------------------------------------- */

interface CurrentBeamArgs {
  kind: ScanKind;
  roi: ROIState;
  region: ROIRequest;
  rasterFrame: Uint16Array;
  rasterResolution: number;
  rasterCursor: number;
  vectorImage: Uint16Array;
  vectorEdge: number;
  vectorCursor: number;
  vectorPattern: "default" | "custom";
  vectorCustomPoints: Float32Array | null;
  vectorCustomRenderPoints: Float32Array | null;
}

interface CurrentBeamPosition {
  x: number;
  y: number;
  adc: number;
}

function activeROIRegion(roi: ROIState): ROIRequest {
  return roi.selection ?? {
    x_start: roi.x_origin,
    x_end: roi.x_end,
    y_start: roi.y_origin,
    y_end: roi.y_end,
  };
}

function currentBeamPosition(args: CurrentBeamArgs): CurrentBeamPosition | null {
  if (args.kind === "raster") {
    if (args.rasterCursor <= 0 || args.rasterResolution <= 0) return null;
    const idx = Math.min(args.rasterCursor, args.rasterFrame.length) - 1;
    const col = idx % args.rasterResolution;
    const row = Math.floor(idx / args.rasterResolution);
    return {
      ...mapIndexToRegion(col, row, args.rasterResolution, args.region),
      adc: args.rasterFrame[idx] ?? 0,
    };
  }

  if (args.vectorCursor <= 0 || args.vectorEdge <= 0) return null;
  const idx = args.vectorCursor - 1;
  if (args.vectorPattern === "custom" && args.vectorCustomPoints) {
    const pointCount = args.vectorCustomPoints.length / 2;
    if (idx >= pointCount) return null;
    const x = args.vectorCustomPoints[2 * idx] | 0;
    const y = args.vectorCustomPoints[2 * idx + 1] | 0;
    const renderCol = args.vectorCustomRenderPoints?.[2 * idx] ?? x;
    const renderRow = args.vectorCustomRenderPoints?.[2 * idx + 1] ?? y;
    const safeCol = Math.max(0, Math.min(args.vectorEdge - 1, renderCol | 0));
    const safeRow = Math.max(0, Math.min(args.vectorEdge - 1, renderRow | 0));
    return {
      x,
      y,
      adc: args.vectorImage[safeRow * args.vectorEdge + safeCol] ?? 0,
    };
  }

  const col = Math.floor(idx / args.vectorEdge);
  const row = idx % args.vectorEdge;
  if (col >= args.vectorEdge) return null;
  return {
    ...mapIndexToRegion(col, row, args.vectorEdge, args.region),
    adc: args.vectorImage[row * args.vectorEdge + col] ?? 0,
  };
}

function mapIndexToRegion(
  col: number,
  row: number,
  edge: number,
  region: ROIRequest
): { x: number; y: number } {
  const denom = Math.max(1, edge - 1);
  return {
    x: lerp(region.x_start, region.x_end, col / denom),
    y: lerp(region.y_start, region.y_end, row / denom),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function formatPoint(x: number, y: number, unit: string): string {
  return `(${formatCoord(x)}, ${formatCoord(y)}) ${unit}`;
}

function formatCoord(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
}

/* -------- painters ----------------------------------------------------- */

/**
 * `populated` indicates how much of the buffer has real data; the rest
 * is transparent so the surrounding UI background shows through.
 */
function paintGrayscale(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);

  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < limit; i++) {
    const v = buf[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit === 0) {
    lo = 0;
    hi = 0;
  }

  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  const totalPx = edge * edge;
  const reg = limit < totalPx ? limit : totalPx;
  for (let i = 0; i < reg; i++) {
    const g = scaleSample(buf[i], lo, hi);
    const p = i * 4;
    data[p + 0] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  // Trailing unscanned region remains transparent.
  for (let p = reg * 4; p < data.length; p += 4) {
    data[p + 0] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);

  return { min: lo, max: hi, populated: limit };
}

/**
 * Paint the vector buffer at native DAC resolution (2048x2048) with
 * stride x stride block-fill per buffer cell.
 *
 * The buffer holds an `edge x edge` dense image (e.g. 256x256 for a
 * default scan with vector_resolution=256). In native render mode each
 * cell represents an 8x8 region of DAC space, so we fill that entire
 * region with the cell's value. Result: a dense 2048x2048 image where
 * pixel coordinates correspond 1:1 to DAC codes.
 *
 * The raw ADC range is computed once over the compact buffer (not over
 * the post-block-fill canvas), so each unique cell counts equally.
 */
function paintVectorDefault(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);
  const range = vectorDefaultRange(buf, edge, limit);
  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  for (let i = 0; i < limit; i++) {
    const col = (i / edge) | 0;
    const row = i % edge;
    if (col >= edge) break;
    const idx = row * edge + col;
    const g = scaleSample(buf[idx], range.min, range.max);
    const p = idx * 4;
    data[p + 0] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return range;
}

function paintVectorCustom(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  points: Float32Array,
  populated: number
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, points.length / 2);
  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < limit; i++) {
    const x = points[2 * i] | 0;
    const y = points[2 * i + 1] | 0;
    if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
    const v = buf[y * edge + x];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit === 0) {
    lo = 0;
    hi = 0;
  }

  const img = ctx.createImageData(edge, edge);
  const data = img.data;
  for (let i = 0; i < limit; i++) {
    const x = points[2 * i] | 0;
    const y = points[2 * i + 1] | 0;
    if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
    const idx = y * edge + x;
    const g = scaleSample(buf[idx], lo, hi);
    const p = idx * 4;
    data[p + 0] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return { min: lo, max: hi, populated: limit };
}

function paintVectorDefaultBlockFill(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  stride: number
): PaintStats {
  const nativeSize = edge * stride; // = DAC_RANGE
  if (canvas.width !== nativeSize || canvas.height !== nativeSize) {
    canvas.width = nativeSize;
    canvas.height = nativeSize;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);

  const range = vectorDefaultRange(buf, edge, limit);

  const img = ctx.createImageData(nativeSize, nativeSize);
  const data = img.data;

  // Pre-fill background as transparent (consistent with raster).
  for (let p = 0; p < data.length; p += 4) {
    data[p + 0] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 0;
  }

  // Paint each populated buffer cell as a stride x stride block.
  for (let i = 0; i < limit; i++) {
    const cellCol = (i / edge) | 0;
    const cellRow = i % edge;
    if (cellCol >= edge) break;
    const cellIdx = cellRow * edge + cellCol;
    const g = scaleSample(buf[cellIdx], range.min, range.max);
    const baseY = cellRow * stride;
    const baseX = cellCol * stride;

    // Paint the stride x stride block. Inner loop is unrolled across
    // canvas-row steps because successive pixels in a canvas row are
    // contiguous in `data`.
    for (let dy = 0; dy < stride; dy++) {
      let p = ((baseY + dy) * nativeSize + baseX) * 4;
      for (let dx = 0; dx < stride; dx++) {
        data[p + 0] = g;
        data[p + 1] = g;
        data[p + 2] = g;
        data[p + 3] = 255;
        p += 4;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return range;
}

function vectorDefaultRange(buf: Uint16Array, edge: number, limit: number): PaintStats {
  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < limit; i++) {
    const col = (i / edge) | 0;
    const row = i % edge;
    if (col >= edge) break;
    const v = buf[row * edge + col];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit === 0) {
    lo = 0;
    hi = 0;
  }
  return { min: lo, max: hi, populated: limit };
}

function scaleSample(value: number, lo: number, hi: number): number {
  if (hi <= lo) return hi > 0 ? 255 : 0;
  return Math.max(0, Math.min(255, Math.round(((value - lo) * 255) / (hi - lo))));
}
