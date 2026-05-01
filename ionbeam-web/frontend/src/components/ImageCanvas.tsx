/**
 * Renders the raster grayscale frame or vector ADC image onto a canvas.
 *
 * Both modes share the same painter: a flat Uint16Array of edge*edge
 * samples, auto-leveled (min/max stretched to 0..255) and putImageData'd
 * onto a canvas at native resolution. CSS scales up; image-rendering:
 * pixelated keeps integer-zoom crisp.
 *
 * Auto-leveling is the same trick pyqtgraph's HistogramLUTItem does in
 * the PyQt reference UI when autoLevels=True. With ADC outputs that
 * frequently sit in the low 12 bits, fixed 0..65535 mapping renders
 * almost everything as black; auto-leveling pulls the actual signal
 * range out into visible contrast.
 *
 * For raster the buffer is fully populated row-major as the FPGA emits
 * samples. For vector default it's populated densely too, just in
 * column-major order. For vector custom it's sparse — only the points
 * the host requested have data; unpopulated cells stay zero.
 */
import { useEffect, useRef, useState } from "react";

import { useAppSelector } from "../store";
import type { ScanKind } from "../store/scanSlice";

interface PaintStats {
  min: number;
  max: number;
  populated: number;
}

export function ImageCanvas({ kind }: { kind: ScanKind }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<PaintStats>({ min: 0, max: 0, populated: 0 });

  const revision = useAppSelector((s) => s.image.revision);

  // Raster fields
  const resolution = useAppSelector((s) => s.image.resolution);
  const frame = useAppSelector((s) => s.image.frame);
  const cursor = useAppSelector((s) => s.image.cursor);

  // Vector fields
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorPattern = useAppSelector((s) => s.image.vectorPattern);
  const vectorCustomCount = useAppSelector((s) => s.image.vectorCustomCount);

  const phase = useAppSelector((s) => s.scan.phase);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (kind === "raster") {
      const s = paintGrayscale(canvas, frame, resolution, cursor);
      setStats(s);
    } else {
      // For vector, "populated" means either all of edge^2 (default sweep
      // is dense) or the custom-points count. Pass the cursor as the
      // populated count for default, and the cursor for custom too —
      // unfilled cells in custom mode stay zero and contribute to min=0.
      const s = paintGrayscale(canvas, vectorImage, vectorEdge, vectorCursor);
      setStats(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, kind]);

  const totalRasterPx = resolution * resolution;
  const totalVectorSamples =
    vectorPattern === "default" ? vectorEdge * vectorEdge : vectorCustomCount;

  const pct =
    kind === "raster" && totalRasterPx > 0
      ? Math.min(100, (cursor / totalRasterPx) * 100)
      : kind === "vector" && totalVectorSamples > 0
      ? Math.min(100, (vectorCursor / totalVectorSamples) * 100)
      : phase === "completed"
      ? 100
      : 0;

  // Display canvas size: aim for a roughly 640–768 px viewport edge,
  // integer-multiple of native resolution where possible to keep crisp.
  const nativeEdge = kind === "raster" ? resolution : vectorEdge;
  const canvasSize = Math.min(
    nativeEdge * Math.max(1, Math.floor(640 / nativeEdge)),
    768
  );

  return (
    <div>
      <div className="canvas-frame">
        <canvas
          ref={canvasRef}
          width={nativeEdge}
          height={nativeEdge}
          style={{ width: canvasSize, height: canvasSize }}
        />
      </div>

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
            </span>
          </>
        )}
        {stats.populated > 0 && (
          <span title="Display level: 1st..99th percentile of received uint16 samples, stretched to 0..255. Outliers clip to black/white.">
            level <b>{stats.min}..{stats.max}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* -------- painters ----------------------------------------------------- */

/**
 * Paint a Uint16 image with percentile-based auto-leveling. The earlier
 * implementation used absolute min/max, which collapses to near-black
 * when even a few outlier pixels (hardware glitches, dead-zone-zero
 * pixels, saturated samples) pull the range from ~700 to ~33000 — the
 * useful 99% of data then maps to gray values 0..2.
 *
 * Percentile clipping is the standard trick (pyqtgraph's
 * HistogramLUTItem, ImageJ, matplotlib's robust=True): stretch the
 * 1st..99th percentile of received pixels to 0..255 and clip outliers
 * to 0/255. Robust to outliers, no sort needed.
 *
 * Implementation: 1024-bucket histogram (each bucket = 64 uint16 codes
 * wide), walk the cumulative count to find p1 and p99 buckets, take the
 * bucket midpoints as cut-off values. Linear pass over `populated`
 * pixels — same complexity as the old min/max.
 *
 * `populated` indicates how much of the buffer has real data; the rest
 * is rendered as faint navy so the operator can tell "no data" from
 * "received zeros".
 */

const HIST_BUCKETS = 1024;
const HIST_SHIFT = 6; // 65536 / 1024 = 64 values per bucket; >> 6
const PERCENTILE_LO = 0.01;
const PERCENTILE_HI = 0.99;

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

  // Build a histogram of received values. Each bucket covers 64 codes,
  // which is finer than display precision (256 gray levels) so the
  // percentile cut-offs map cleanly back to gray afterward.
  const hist = new Uint32Array(HIST_BUCKETS);
  for (let i = 0; i < limit; i++) {
    hist[buf[i] >> HIST_SHIFT]++;
  }

  // Find p1 and p99 cut-off uint16 values. Walk cumulative count.
  let lo = 0;
  let hi = 0xffff;
  if (limit > 0) {
    const target_lo = limit * PERCENTILE_LO;
    const target_hi = limit * PERCENTILE_HI;
    let cum = 0;
    let found_lo = false;
    for (let b = 0; b < HIST_BUCKETS; b++) {
      cum += hist[b];
      if (!found_lo && cum >= target_lo) {
        lo = b << HIST_SHIFT;
        found_lo = true;
      }
      if (cum >= target_hi) {
        hi = ((b + 1) << HIST_SHIFT) - 1;
        break;
      }
    }
    // Pathological cases (uniform field, single-bucket data): collapse
    // span to 1 so we don't divide by zero. The image then renders as
    // mid-gray, which is the right answer for "all pixels equal".
    if (hi <= lo) hi = lo + 1;
  }
  const span = hi > lo ? hi - lo : 1;

  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  const totalPx = edge * edge;
  const reg = limit < totalPx ? limit : totalPx;
  for (let i = 0; i < reg; i++) {
    const v = buf[i];
    // Clamp into [lo, hi] then linearly map to [0, 255].
    let g: number;
    if (v <= lo) g = 0;
    else if (v >= hi) g = 255;
    else g = ((v - lo) * 255 / span) | 0;
    const p = i * 4;
    data[p + 0] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  // Trailing unscanned region (raster mode only fills up to cursor) →
  // faint navy.
  for (let p = reg * 4; p < data.length; p += 4) {
    data[p + 0] = 6;
    data[p + 1] = 16;
    data[p + 2] = 30;
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return { min: lo, max: hi, populated: limit };
}
