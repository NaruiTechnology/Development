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
          <span title="Auto-level: min/max of received uint16 samples stretched to 0..255 on display">
            level <b>{stats.min}..{stats.max}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* -------- painters ----------------------------------------------------- */

/**
 * Paint a Uint16 image with auto-leveling. `populated` indicates how much
 * of the buffer has real data; the rest is rendered as faint navy so the
 * operator can tell "no data" from "received zeros".
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

  // Scan the populated region for min/max. For sparse / scattered fills
  // (custom vector) `populated` may exceed valid data, but every cell in
  // the image is initialized to 0 and zeros only widen the min so the
  // visualization stays consistent.
  let min = 0xffff;
  let max = 0;
  const limit = Math.min(populated, buf.length);
  for (let i = 0; i < limit; i++) {
    const v = buf[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (limit === 0) {
    min = 0;
    max = 0;
  }
  const span = max > min ? max - min : 1;

  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  // Paint the entire buffer. For sparse / unfilled areas the value is 0,
  // which after auto-level becomes black — visually distinct from the
  // navy "not yet scanned" tint we apply below for purely raster mode.
  const totalPx = edge * edge;
  const reg = limit < totalPx ? limit : totalPx;
  for (let i = 0; i < reg; i++) {
    const v = buf[i];
    const g = ((v - min) * 255 / span) | 0;
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

  return { min, max, populated: limit };
}
