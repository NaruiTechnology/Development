import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

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

interface ImageState {
  // ---------- raster -----------------------------------------------------
  resolution: number;
  cursor: number;
  frame: Uint16Array;

  // ---------- vector -----------------------------------------------------
  vectorPattern: VectorPattern;
  /** Edge length of the square render target. 2048 matches the default
   *  sweep and the FPGA DAC range. */
  vectorEdge: number;
  /** edge*edge uint16 grayscale image written sparsely in custom mode and
   *  densely in default mode. */
  vectorImage: Uint16Array;
  /** For custom pattern only: flat (x, y) pairs, length 2*N. */
  vectorCustomPoints: Float32Array | null;
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
  vectorEdge: VEC_EDGE,
  vectorImage: new Uint16Array(VEC_EDGE * VEC_EDGE),
  vectorCustomPoints: null,
  vectorCustomCount: 0,
  vectorCursor: 0,

  revision: 0,
};

interface SetupVectorPayload {
  pattern: VectorPattern;
  /** (x, y, dwell) triples copied from VectorRequest.points for custom mode. */
  points?: Array<[number, number, number]> | null;
  /** Edge of the render target. Defaults to 2048 (FPGA DAC range). */
  edge?: number;
}

const slice = createSlice({
  name: "image",
  initialState,
  reducers: {
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
      state.vectorEdge = edge;
      state.vectorImage = new Uint16Array(edge * edge);
      state.vectorCursor = 0;

      if (pattern === "custom" && a.payload.points && a.payload.points.length) {
        const pts = a.payload.points;
        const flat = new Float32Array(pts.length * 2);
        for (let i = 0; i < pts.length; i++) {
          flat[2 * i] = pts[i][0];
          flat[2 * i + 1] = pts[i][1];
        }
        state.vectorCustomPoints = flat;
        state.vectorCustomCount = pts.length;
      } else {
        state.vectorCustomPoints = null;
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
        const pts = state.vectorCustomPoints;
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
  resetRaster,
  appendRaster,
  setupVector,
  appendVectorSamples,
  resetVector,
} = slice.actions;

export default slice.reducer;
