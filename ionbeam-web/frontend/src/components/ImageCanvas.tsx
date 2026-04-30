/**
 * Renders the raster grayscale frame (or vector point plot) onto a canvas.
 *
 * Strategy:
 *   - Maintain a backing canvas at the native resolution (e.g. 512×512)
 *     and one ImageData of the same size that we mutate in place.
 *   - On every revision bump, copy bytes from imageSlice.frame into the
 *     RGBA channels of imageData and call putImageData.
 *   - The visible canvas uses CSS to scale up; image-rendering: pixelated
 *     keeps it crisp at integer zooms.
 *
 * For vector mode we instead clear and re-plot all received points in a
 * 1024-wide square. This is the analogue of the PyQt ImageDisplay's
 * pyqtgraph view, simplified for the browser.
 */
import { useEffect, useRef } from "react";

import { useAppSelector } from "../store";
import type { ScanKind } from "../store/scanSlice";

const VECTOR_PLOT_SIZE = 768; // Viewport pixels for vector visualisation.
const VECTOR_COORD_RANGE = 2048; // Max coordinate the FPGA will emit (DAC range).

export function ImageCanvas({ kind }: { kind: ScanKind }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Subscribing to revision triggers a repaint without comparing the buffer.
  const revision = useAppSelector((s) => s.image.revision);
  const resolution = useAppSelector((s) => s.image.resolution);
  const frame = useAppSelector((s) => s.image.frame);
  const cursor = useAppSelector((s) => s.image.cursor);
  const vectorPoints = useAppSelector((s) => s.image.vectorPoints);
  const vectorCount = useAppSelector((s) => s.image.vectorCount);
  const phase = useAppSelector((s) => s.scan.phase);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (kind === "raster") {
      paintRaster(canvas, frame, resolution);
    } else {
      paintVector(canvas, vectorPoints, vectorCount);
    }
    // Depend on revision to repaint efficiently.
    // Including kind, frame, resolution, vectorPoints, vectorCount keeps
    // a clean tab-switch from showing stale pixels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, kind]);

  const totalPixels = resolution * resolution;
  const pct =
    kind === "raster" && totalPixels > 0
      ? Math.min(100, (cursor / totalPixels) * 100)
      : phase === "completed"
      ? 100
      : 0;

  const canvasSize =
    kind === "raster" ? Math.min(resolution * Math.max(1, Math.floor(640 / resolution)), 768) : VECTOR_PLOT_SIZE;

  return (
    <div>
      <div className="canvas-frame">
        <canvas
          ref={canvasRef}
          width={kind === "raster" ? resolution : VECTOR_COORD_RANGE}
          height={kind === "raster" ? resolution : VECTOR_COORD_RANGE}
          style={{
            width: canvasSize,
            height: canvasSize,
          }}
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
          <span>
            pixels{" "}
            <b>
              {cursor.toLocaleString()} / {totalPixels.toLocaleString()}
            </b>
          </span>
        ) : (
          <span>
            points <b>{vectorCount.toLocaleString()}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* -------- painters ----------------------------------------------------- */

function paintRaster(
  canvas: HTMLCanvasElement,
  frame: Uint8ClampedArray,
  resolution: number
): void {
  if (canvas.width !== resolution || canvas.height !== resolution) {
    canvas.width = resolution;
    canvas.height = resolution;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(resolution, resolution);
  const data = img.data;
  const n = Math.min(frame.length, resolution * resolution);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = frame[i];
    data[p + 0] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  // Fill the not-yet-scanned region with a faint navy so the user can
  // distinguish "no data" from "received zeros".
  for (let p = n * 4; p < data.length; p += 4) {
    data[p + 0] = 6;
    data[p + 1] = 16;
    data[p + 2] = 30;
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function paintVector(
  canvas: HTMLCanvasElement,
  triples: Float32Array,
  count: number
): void {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Background.
  ctx.fillStyle = "#050a14";
  ctx.fillRect(0, 0, w, h);

  if (count === 0) return;

  // Plot points; alpha-accumulate so dense areas brighten naturally.
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let i = 0; i < count; i++) {
    const x = triples[i * 3 + 0] | 0;
    const y = triples[i * 3 + 1] | 0;
    const v = triples[i * 3 + 2] | 0;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const p = (y * w + x) * 4;
    // Saturate a teal hue and let value drive brightness.
    data[p + 0] = Math.max(data[p + 0], v >> 1);
    data[p + 1] = Math.max(data[p + 1], v);
    data[p + 2] = Math.max(data[p + 2], v);
    data[p + 3] = 255;
  }
  // Fill background where alpha is 0 with the navy.
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) {
      data[p + 0] = 6;
      data[p + 1] = 16;
      data[p + 2] = 30;
      data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
