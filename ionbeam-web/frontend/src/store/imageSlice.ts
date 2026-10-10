import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ROIRequest, VectorPoint, VectorPointTuple, VectorScanPath } from "../types/api";
import { vectorScanSampleCount, vectorScanSamplePixel } from "../lib/vectorScanPath";

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
  /** Index of the next raster pixel to be written (the beam position). */
  cursor: number;
  /** Pixels of `frame` that hold valid data. Equals `cursor` for a single
   *  frame; once a live (continuous) scan wraps, the whole frame stays
   *  valid and new samples overwrite the previous frame in place — OBI's
   *  Frame.fill_lines roll-over — so the canvas never blanks. */
  filled: number;
  /** Live scan: wrap `cursor` to 0 at the frame end instead of dropping
   *  the extra samples. */
  rasterContinuous: boolean;
  /** Completed frames in the current live scan. */
  rasterFrames: number;
  frame: Uint16Array;

  // ---------- vector -----------------------------------------------------
  vectorPattern: VectorPattern;
  vectorScanPath: VectorScanPath;
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
  /** Sample index of the next vector sample (the beam position). */
  vectorCursor: number;
  /** Samples of the current pass layout that hold valid data. Stays at the
   *  full pass once a live scan wraps, so the whole image keeps rendering
   *  and new samples overwrite it in place (OBI live scan behavior). */
  vectorFilled: number;
  /** Live scan: wrap `vectorCursor` to 0 at the pass end. */
  vectorContinuous: boolean;
  /** Completed passes in the current live scan. */
  vectorPasses: number;
  /** Whether ROI gray feedback should be composited after this cycle completes. */
  retainVectorFeedbackOnComplete: boolean;

  // ---------- repaint trigger -------------------------------------------
  revision: number;
}

const RES = 512;
const VEC_EDGE = 2048;

const initialState: ImageState = {
  resolution: RES,
  cursor: 0,
  filled: 0,
  rasterContinuous: false,
  rasterFrames: 0,
  frame: new Uint16Array(RES * RES),

  vectorPattern: "default",
  vectorScanPath: "vertical_raster",
  vectorSource: "vector",
  vectorEdge: VEC_EDGE,
  vectorImage: new Uint16Array(VEC_EDGE * VEC_EDGE),
  vectorCustomPoints: null,
  vectorCustomRenderPoints: null,
  vectorCustomBlankMask: null,
  vectorCustomSpotMask: null,
  vectorCustomCount: 0,
  vectorCursor: 0,
  vectorFilled: 0,
  vectorContinuous: false,
  vectorPasses: 0,
  retainVectorFeedbackOnComplete: true,

  revision: 0,
};

interface SetupVectorPayload {
  pattern: VectorPattern;
  scanPath?: VectorScanPath;
  /** Custom points copied from VectorRequest.points for custom mode. */
  points?: Array<VectorPointTuple | VectorPoint> | null;
  /** Edge of the render target. Defaults to 2048 (FPGA DAC range). */
  edge?: number;
  /** Active ROI in 14-bit DAC coordinates. Used to map custom points to pixels. */
  roi?: ROIRequest | null;
  simulationBitmap?: { width: number; height: number } | null;
  /** Live scan: wrap at the pass end instead of stopping. */
  continuous?: boolean;
  /** Keep the current image (and its filled count) when the layout is
   *  unchanged, like OBI's FrameBuffer._set_current_frame: only the write
   *  position returns to the start, the previous pixels stay on screen. */
  preserveImage?: boolean;
}

const slice = createSlice({
  name: "image",
  initialState,
  reducers: {
    bumpRevision(state) {
      state.revision++;
    },

    setRetainVectorFeedbackOnComplete(state, a: PayloadAction<boolean>) {
      state.retainVectorFeedbackOnComplete = a.payload;
    },

    /* ---------- raster -------------------------------------------------- */

    resetRaster(
      state,
      a: PayloadAction<{ resolution: number; preserveFrame?: boolean; continuous?: boolean }>,
    ) {
      const keepExistingFrame =
        a.payload.preserveFrame === true &&
        state.resolution === a.payload.resolution &&
        state.frame.length === a.payload.resolution * a.payload.resolution;
      state.resolution = a.payload.resolution;
      if (!keepExistingFrame) {
        state.frame = new Uint16Array(a.payload.resolution * a.payload.resolution);
        state.filled = 0;
      }
      // A preserved frame keeps its `filled` count, so the previous image
      // stays on screen while the new pass overwrites it from the top.
      state.cursor = 0;
      state.rasterContinuous = a.payload.continuous === true;
      state.rasterFrames = 0;
      state.revision++;
    },
    appendRaster(state, a: PayloadAction<{ pixels: Uint16Array }>) {
      const { pixels } = a.payload;
      const length = state.frame.length;
      if (length === 0) return;
      let offset = 0;
      while (offset < pixels.length) {
        const remaining = length - state.cursor;
        const n = Math.min(pixels.length - offset, remaining);
        state.frame.set(pixels.subarray(offset, offset + n), state.cursor);
        state.cursor += n;
        offset += n;
        if (state.cursor > state.filled) state.filled = state.cursor;
        if (state.cursor < length) break;
        // Frame end. A single frame drops anything extra (unchanged
        // behavior); a live scan rolls over and keeps painting.
        if (!state.rasterContinuous) break;
        state.cursor = 0;
        state.filled = length;
        state.rasterFrames++;
      }
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
      const scanPath = a.payload.scanPath ?? "vertical_raster";
      const source: VectorSource = pattern === "custom" && a.payload.roi ? "roi" : "vector";
      const customCount = pattern === "custom"
        ? a.payload.points?.length ??
          (a.payload.simulationBitmap
            ? Math.max(1, a.payload.simulationBitmap.width | 0) *
              Math.max(1, a.payload.simulationBitmap.height | 0)
            : 0)
        : 0;
      const keepImage =
        a.payload.preserveImage === true &&
        state.vectorPattern === pattern &&
        state.vectorScanPath === scanPath &&
        state.vectorSource === source &&
        state.vectorEdge === edge &&
        state.vectorImage.length === edge * edge &&
        (pattern !== "custom" || state.vectorCustomCount === customCount);
      state.vectorPattern = pattern;
      state.vectorScanPath = scanPath;
      state.vectorSource = source;
      state.vectorEdge = edge;
      if (!keepImage) {
        state.vectorImage = new Uint16Array(edge * edge);
        state.vectorFilled = 0;
      }
      state.vectorCursor = 0;
      state.vectorContinuous = a.payload.continuous === true;
      state.vectorPasses = 0;

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
      const isDefault = state.vectorPattern === "default";
      const pts = state.vectorCustomRenderPoints;
      // Samples in one pass: the default sweep covers edge x edge, custom
      // replays its point list.
      const passLength = isDefault
        ? vectorScanSampleCount(edge, state.vectorScanPath)
        : state.vectorCustomCount;

      let k = 0;
      while (k < N) {
        const cur = state.vectorCursor;
        const room = passLength > 0 ? passLength - cur : N - k;
        const n = Math.max(0, Math.min(N - k, room));
        if (isDefault) {
          for (let m = 0; m < n; m++) {
            const pixel = vectorScanSamplePixel(cur + m, edge, state.vectorScanPath);
            if (pixel) {
              state.vectorImage[pixel.y * edge + pixel.x] = values[k + m];
            }
          }
        } else if (pts) {
          for (let m = 0; m < n; m++) {
            const i = cur + m;
            const x = pts[2 * i] | 0;
            const y = pts[2 * i + 1] | 0;
            if (x >= 0 && x < edge && y >= 0 && y < edge) {
              state.vectorImage[y * edge + x] = values[k + m];
            }
          }
        }
        k += n;
        state.vectorCursor = cur + n;
        if (state.vectorCursor > state.vectorFilled) state.vectorFilled = state.vectorCursor;
        if (passLength <= 0 || state.vectorCursor < passLength) break;
        if (!state.vectorContinuous) {
          // Single pass: count (but do not paint) anything past the end,
          // matching the previous cursor behavior.
          state.vectorCursor += N - k;
          break;
        }
        // Pass end in a live scan: roll over and keep painting in place.
        state.vectorCursor = 0;
        state.vectorFilled = passLength;
        state.vectorPasses++;
      }
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
        state.vectorScanPath !== "vertical_raster" ||
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
      state.vectorFilled = 0;
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
  setRetainVectorFeedbackOnComplete,
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
