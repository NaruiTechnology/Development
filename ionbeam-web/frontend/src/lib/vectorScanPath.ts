import type { VectorScanPath } from "../types/api";

// Horizontal paths (X fast/inner axis) listed first, with
// horizontal_sawtooth as the practical default: a scope probe on the X
// DAC output sees a continuous per-line ramp, matching a reference OBI
// capture. vertical_* paths make X the slow/outer axis instead, which
// looks like a staircase on a scope even though the DAC itself is fine
// (X only steps once per full column) — see VectorScanPathField's
// default selection and /scan/dac_ramp/run for a true single-axis check.
export const VECTOR_SCAN_PATHS: readonly VectorScanPath[] = [
  "horizontal_sawtooth",
  "horizontal_triangle",
  "vertical_raster",
  "vertical_serpentine",
];

export function vectorScanSampleCount(edge: number, path: VectorScanPath): number {
  const size = Math.max(1, Math.trunc(edge));
  return size * size;
}

export function vectorScanSamplePixel(
  sampleIndex: number,
  edge: number,
  path: VectorScanPath,
): { x: number; y: number } | null {
  const size = Math.max(1, Math.trunc(edge));
  const index = Math.max(0, Math.trunc(sampleIndex));
  if (index >= vectorScanSampleCount(size, path)) return null;

  if (path === "horizontal_sawtooth" || path === "horizontal_triangle") {
    const y = Math.floor(index / size);
    const offset = index % size;
    return {
      x: path === "horizontal_triangle" && y % 2 === 1 ? size - 1 - offset : offset,
      y,
    };
  }

  const x = Math.floor(index / size);
  const offset = index % size;
  return {
    x,
    y: path === "vertical_serpentine" && x % 2 === 1 ? size - 1 - offset : offset,
  };
}

export function* bitmapScanCoordinates(
  width: number,
  height: number,
  scanPath: VectorScanPath,
): Generator<[number, number]> {
  if (scanPath === "vertical_raster" || scanPath === "vertical_serpentine") {
    for (let x = 0; x < width; x++) {
      for (let offset = 0; offset < height; offset++) {
        const y = scanPath === "vertical_serpentine" && x % 2 === 1
          ? height - 1 - offset
          : offset;
        yield [x, y];
      }
    }
    return;
  }

  for (let y = 0; y < height; y++) {
    for (let offset = 0; offset < width; offset++) {
      const x = scanPath === "horizontal_triangle" && y % 2 === 1
        ? width - 1 - offset
        : offset;
      yield [x, y];
    }
  }
}
