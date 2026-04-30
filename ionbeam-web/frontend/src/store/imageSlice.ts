import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

interface ImageState {
  /** Raster: square edge in pixels matching scanSlice.raster.resolution. */
  resolution: number;
  /** Pixel cursor (next index to write into, row-major). */
  cursor: number;
  /**
   * Backing pixel buffer. Width*height bytes, 0..255 grayscale. Stored on
   * the slice so it survives component remounts (e.g. tab change). Marked
   * non-serialisable in store config.
   */
  frame: Uint8ClampedArray;
  /** Increment to force <Canvas> repaint without diffing the buffer. */
  revision: number;
  /** For vector mode — stash of (x,y,value) triples for plotting. */
  vectorPoints: Float32Array;
  vectorCount: number;
}

const RES = 512;

const initialState: ImageState = {
  resolution: RES,
  cursor: 0,
  frame: new Uint8ClampedArray(RES * RES),
  revision: 0,
  vectorPoints: new Float32Array(4096 * 3),
  vectorCount: 0,
};

const slice = createSlice({
  name: "image",
  initialState,
  reducers: {
    /** Resize and clear the raster buffer. Called when resolution changes. */
    resetRaster(state, a: PayloadAction<{ resolution: number }>) {
      state.resolution = a.payload.resolution;
      state.frame = new Uint8ClampedArray(a.payload.resolution * a.payload.resolution);
      state.cursor = 0;
      state.revision++;
    },
    /**
     * Append a chunk of pixels (already 8-bit grayscale, the high bytes of
     * each uint16 sample) to the raster frame at the current cursor.
     */
    appendRaster(state, a: PayloadAction<{ pixels: Uint8ClampedArray }>) {
      const { pixels } = a.payload;
      const remaining = state.frame.length - state.cursor;
      const n = Math.min(pixels.length, remaining);
      state.frame.set(pixels.subarray(0, n), state.cursor);
      state.cursor += n;
      state.revision++;
    },
    /** Append (x,y,value) triples for vector display. */
    appendVector(
      state,
      a: PayloadAction<{ triples: Float32Array }>
    ) {
      const { triples } = a.payload;
      // Grow if needed (geometric).
      const needed = state.vectorCount * 3 + triples.length;
      if (needed > state.vectorPoints.length) {
        const grown = new Float32Array(Math.max(needed, state.vectorPoints.length * 2));
        grown.set(state.vectorPoints);
        state.vectorPoints = grown;
      }
      state.vectorPoints.set(triples, state.vectorCount * 3);
      state.vectorCount += triples.length / 3;
      state.revision++;
    },
    resetVector(state) {
      state.vectorPoints = new Float32Array(4096 * 3);
      state.vectorCount = 0;
      state.revision++;
    },
  },
});

export const { resetRaster, appendRaster, appendVector, resetVector } = slice.actions;
export default slice.reducer;
