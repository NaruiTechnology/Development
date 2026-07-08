import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ROIRequest, VectorPoint, VectorPointTuple } from "../types/api";

/**
 * Image / pixel buffers, kept here (outside the serialisability check)
 * because Uint16Arrays don't round-trip cleanly through Redux DevTools.
 *
 * Raster:
 *   `frame` is a flat Uint16Array of size resolution^2, written row-major
 *   in the order the FPGA emits samples. Painter auto-levels at display.
 *
 * Vector:
 *   The FPGA streams uint16 ADC samples in the same order the host's
 *   point script (default sweep or custom list) sent the (x, y) commands.
 *   We render into a 2048x2048 image whose pixel coordinates come from
 *   that script. For default the mapping is closed-form (`i // edge`,
 *   `i % edge`); for custom we need the actual point list, which the WS
 *   handler passes in via `setupVector` at scan start.
 */

export type VectorPattern = "default" | "custom";
export type VectorSource = "vector" | "roi";

interface ImageState {
  // ---------- raster -----------------------------------------------------
  resolution: number;
  cursor: number;
  frame: Uint16Array;

  // ---------- vector -----------------------------------------------------
  vectorPattern: VectorPattern;
  vectorSource: VectorSource;
  /** Edge length of the square render target. 2048 matches the default
   *  sweep and the FPGA DAC range. */
  vectorEdge: number;
  /** edge*edge uint16 grayscale image written sparsely in custom mode and
   *  densely in default mode. */
  vectorImage: Uint16Array;
  /** For custom pattern only: flat (x, y) pairs, length 2*N. */
  vectorCustomPoints: Float32Array | null;
  /** For custom pattern only: flat render-space (x, y) pairs, length 2*N. */
  vectorCustomRenderPoints: Float32Array | null;
  /** For custom pattern only: 1 when the point is explicitly beam-blanked. */
  vectorCustomBlankMask: Uint8Array | null;
  /** For custom pattern only: 1 when the point is a selected Spot beam-on pixel. */
  vectorCustomSpotMask: Uint8Array | null;
  vectorCustomCount: number;
  /** Number of ADC samples received so far. */
  vectorCursor: number;

  // ---------- repaint trigger -------------------------------------------
  revision: number;
}

const RES = 512;
const VEC_EDGE = 2048;

const initialState: ImageState = {
  resolution: RES,
  cursor: 0,
  frame: new Uint16Array(RES * RES),

  vectorPattern: "default",
  vectorSource: "vector",
  vectorEdge: VEC_EDGE,
  vectorImage: new Uint16Array(VEC_EDGE * VEC_EDGE),
  vectorCustomPoints: null,
  vectorCustomRenderPoints: null,
  vectorCustomBlankMask: null,
  vectorCustomSpotMask: null,
  vectorCustomCount: 0,
  vectorCursor: 0,

  revision: 0,
};

interface SetupVectorPayload {
  pattern: VectorPattern;
  /** Custom points copied from VectorRequest.points for custom mode. */
  points?: Array<VectorPointTuple | VectorPoint> | null;
  /** Edge of the render target. Defaults to 2048 (FPGA DAC range). */
  edge?: number;
  /** Active ROI in 14-bit DAC coordinates. Used to map custom points to pixels. */
  roi?: ROIRequest | null;
  simulationBitmap?: { width: number; height: number } | null;
}

const slice = createSlice({
  name: "image",
  initialState,
  reducers: {
    bumpRevision(state) {
      state.revision++;
    },

    /* ---------- raster -------------------------------------------------- */

    resetRaster(state, a: PayloadAction<{ resolution: number }>) {
      state.resolution = a.payload.resolution;
      state.frame = new Uint16Array(a.payload.resolution * a.payload.resolution);
      state.cursor = 0;
      state.revision++;
    },
    appendRaster(state, a: PayloadAction<{ pixels: Uint16Array }>) {
      const { pixels } = a.payload;
      const remaining = state.frame.length - state.cursor;
      const n = Math.min(pixels.length, remaining);
      state.frame.set(pixels.subarray(0, n), state.cursor);
      state.cursor += n;
      state.revision++;
    },

    /* ---------- vector -------------------------------------------------- */

    /**
     * Configure the vector render target for a new scan. Called once by
     * the WS hook at scan start with the request's pattern and points.
     */
    setupVector(state, a: PayloadAction<SetupVectorPayload>) {
      const pattern = a.payload.pattern;
      const edge = a.payload.edge ?? VEC_EDGE;
      state.vectorPattern = pattern;
      state.vectorSource = pattern === "custom" && a.payload.roi ? "roi" : "vector";
      state.vectorEdge = edge;
      state.vectorImage = new Uint16Array(edge * edge);
      state.vectorCursor = 0;

      if (pattern === "custom" && a.payload.points && a.payload.points.length) {
        const pts = a.payload.points;
        const flat = new Float32Array(pts.length * 2);
        const renderFlat = new Float32Array(pts.length * 2);
        const blankMask = new Uint8Array(pts.length);
        const spotMask = new Uint8Array(pts.length);
        const bounds = customPointBounds(pts, a.payload.roi);
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = pointCoords(pts[i]);
          flat[2 * i] = x;
          flat[2 * i + 1] = y;
          renderFlat[2 * i] = mapCoordToPixel(x, bounds.x0, bounds.x1, edge);
          renderFlat[2 * i + 1] = mapCoordToPixel(y, bounds.y0, bounds.y1, edge);
          blankMask[i] = pointBlanked(pts[i]) ? 1 : 0;
          spotMask[i] = pointSpotHighlighted(pts[i]) ? 1 : 0;
        }
        state.vectorCustomPoints = flat;
        state.vectorCustomRenderPoints = renderFlat;
        state.vectorCustomBlankMask = blankMask;
        state.vectorCustomSpotMask = spotMask;
        state.vectorCustomCount = pts.length;
      } else if (pattern === "custom" && a.payload.simulationBitmap) {
        const width = Math.max(1, a.payload.simulationBitmap.width | 0);
        const height = Math.max(1, a.payload.simulationBitmap.height | 0);
        const count = width * height;
        const flat = new Float32Array(count * 2);
        const renderFlat = new Float32Array(count * 2);
        const bounds = a.payload.roi
          ? {
              x0: Math.min(a.payload.roi.x_start, a.payload.roi.x_end),
              x1: Math.max(a.payload.roi.x_start, a.payload.roi.x_end),
              y0: Math.min(a.payload.roi.y_start, a.payload.roi.y_end),
              y1: Math.max(a.payload.roi.y_start, a.payload.roi.y_end),
            }
          : { x0: 0, x1: 16383, y0: 0, y1: 16383 };
        for (let x = 0; x < width; x++) {
          for (let y = 0; y < height; y++) {
            const i = x * height + y;
            flat[2 * i] = lerp(bounds.x0, bounds.x1, width <= 1 ? 0 : x / (width - 1));
            flat[2 * i + 1] = lerp(bounds.y0, bounds.y1, height <= 1 ? 0 : y / (height - 1));
            renderFlat[2 * i] = mapCoordToPixel(x, 0, Math.max(1, width - 1), edge);
            renderFlat[2 * i + 1] = mapCoordToPixel(y, 0, Math.max(1, height - 1), edge);
          }
        }
        state.vectorCustomPoints = flat;
        state.vectorCustomRenderPoints = renderFlat;
        state.vectorCustomBlankMask = null;
        state.vectorCustomSpotMask = null;
        state.vectorCustomCount = count;
      } else {
        state.vectorCustomPoints = null;
        state.vectorCustomRenderPoints = null;
        state.vectorCustomBlankMask = null;
        state.vectorCustomSpotMask = null;
        state.vectorCustomCount = 0;
      }
      state.revision++;
    },

    /**
     * Append uint16 ADC samples in the order they arrive from the FPGA.
     * Each sample's pixel coordinate is derived from its sample index and
     * the active pattern.
     *
     * Default sweep mapping mirrors `service._default_vector_iter`:
     *     for x in range(edge):
     *         for y in range(edge):
     *             yield x, y
     * so sample i lands at column = i // edge, row = i % edge. Storing
     * row-major as `image[row*edge + col]` makes that
     * `image[(i % edge) * edge + (i // edge)]`.
     */
    appendVectorSamples(state, a: PayloadAction<{ values: Uint16Array }>) {
      const values = a.payload.values;
      const N = values.length;
      const edge = state.vectorEdge;
      const cur = state.vectorCursor;

      if (state.vectorPattern === "default") {
        for (let k = 0; k < N; k++) {
          const i = cur + k;
          const col = (i / edge) | 0; // outer loop var (FPGA's x)
          const row = i % edge; // inner loop var (FPGA's y)
          if (col < edge) {
            state.vectorImage[row * edge + col] = values[k];
          }
        }
      } else {
        const pts = state.vectorCustomRenderPoints;
        const pcnt = state.vectorCustomCount;
        if (pts) {
          for (let k = 0; k < N; k++) {
            const i = cur + k;
            if (i >= pcnt) break;
            const x = pts[2 * i] | 0;
            const y = pts[2 * i + 1] | 0;
            if (x >= 0 && x < edge && y >= 0 && y < edge) {
              state.vectorImage[y * edge + x] = values[k];
            }
          }
        }
      }
      state.vectorCursor += N;
      state.revision++;
    },

    /**
     * Apply the vector line-shift correction after a completed live scan.
     *
     * Backend figure rendering uses `lineShiftPerXRow` from streamData.json
     * to deskew each X row in scan order. The live canvas stores default
     * vector data transposed as image[row * edge + col], so the equivalent
     * operation is a roll down each rendered X column.
     */
    correctVectorLineShift(
      state,
      a: PayloadAction<{ lineShiftPerXRow: number }>
    ) {
      const lineShift = Number(a.payload.lineShiftPerXRow);
      const edge = state.vectorEdge;
      if (
        state.vectorPattern !== "default" ||
        !Number.isFinite(lineShift) ||
        lineShift === 0 ||
        edge <= 1 ||
        state.vectorCursor <= 0
      ) {
        return;
      }

      const corrected = new Uint16Array(state.vectorImage.length);
      for (let col = 0; col < edge; col++) {
        const shift = Math.round(col * lineShift);
        const normalizedShift = ((shift % edge) + edge) % edge;
        for (let row = 0; row < edge; row++) {
          const srcRow = (row - normalizedShift + edge) % edge;
          corrected[row * edge + col] = state.vectorImage[srcRow * edge + col];
        }
      }
      state.vectorImage = corrected;
      state.revision++;
    },

    /** Clear the vector image without touching pattern / points config.
     *  Used by the Stop / Clear buttons. */
    resetVector(state) {
      state.vectorImage = new Uint16Array(state.vectorEdge * state.vectorEdge);
      state.vectorCursor = 0;
      state.revision++;
    },
  },
});

export const {
  bumpRevision,
  resetRaster,
  appendRaster,
  setupVector,
  appendVectorSamples,
  correctVectorLineShift,
  resetVector,
} = slice.actions;

export default slice.reducer;

function customPointBounds(
  points: Array<VectorPointTuple | VectorPoint>,
  roi?: ROIRequest | null
): { x0: number; x1: number; y0: number; y1: number } {
  if (roi) {
    const x0 = Math.min(roi.x_start, roi.x_end);
    const x1 = Math.max(roi.x_start, roi.x_end);
    const y0 = Math.min(roi.y_start, roi.y_end);
    const y1 = Math.max(roi.y_start, roi.y_end);
    return { x0, x1, y0, y1 };
  }

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const point of points) {
    const [x, y] = pointCoords(point);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0) || x0 === x1) {
    x0 = 0;
    x1 = 16383;
  }
  if (!Number.isFinite(y0) || y0 === y1) {
    y0 = 0;
    y1 = 16383;
  }
  return { x0, x1, y0, y1 };
}

function pointCoords(point: VectorPointTuple | VectorPoint): [number, number] {
  if (Array.isArray(point)) {
    return [point[0], point[1]];
  }
  return [point.x, point.y];
}

function pointBlanked(point: VectorPointTuple | VectorPoint): boolean {
  return Array.isArray(point) ? point[3] === true : point.blank === true;
}

function pointSpotHighlighted(point: VectorPointTuple | VectorPoint): boolean {
  if (Array.isArray(point)) {
    return point[4] === 1 && point[3] === false;
  }
  return point.passIndex === 1 && point.blank === false;
}

function mapCoordToPixel(value: number, start: number, end: number, edge: number): number {
  const denom = end - start;
  if (edge <= 1 || denom === 0) return 0;
  const t = (value - start) / denom;
  return Math.max(0, Math.min(edge - 1, Math.round(t * (edge - 1))));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
