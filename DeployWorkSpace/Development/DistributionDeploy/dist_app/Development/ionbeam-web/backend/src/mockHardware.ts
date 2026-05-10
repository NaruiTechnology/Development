/**
 * Mock hardware. Used when MOCK=1 — generates the same byte format the
 * FastAPI service emits, so the front-end has exactly one code path to
 * handle real and synthetic data.
 *
 * Format reminder (matches glasgow_service.service.raster_scan):
 *
 *   Each WS frame is bytes(chunk) where chunk is a uint16 array. The FPGA's
 *   ImageSerializer emits HIGH byte first then LOW byte, so byte 0 of every
 *   pair is the most-significant 8 bits — i.e. the "8-bit display value"
 *   you'd want to show as grayscale. The front-end samples those high bytes.
 *
 * Termination message is the same JSON the FastAPI service sends:
 *   {"event":"done","chunks":N}
 */
import type { WebSocket } from "ws";

interface RasterParams {
  resolution: number;
  dwell: number;
  latency_bytes: number;
  cookie?: number;
  frame_blank?: boolean;
}

interface VectorParams {
  pattern: "default" | "custom";
  points?: Array<[number, number, number]>;
  latency_bytes: number;
  /** Edge length for default-pattern sweeps (256 / 512 / 1024 / 2048).
   *  Total samples = edge². Coverage is always the full DAC range. */
  vector_resolution?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mandelbrot-ish mock raster so visual differences from real scans are obvious. */
function pixelValue(x: number, y: number, res: number): number {
  // Map (x,y) -> complex plane and run a tiny mandelbrot iteration so the
  // user gets a recognisable, animated image rather than uniform gray.
  const cx = (x / res) * 3.5 - 2.5;
  const cy = (y / res) * 2.0 - 1.0;
  let zx = 0,
    zy = 0;
  let i = 0;
  const max = 64;
  while (i < max && zx * zx + zy * zy < 4) {
    const nx = zx * zx - zy * zy + cx;
    zy = 2 * zx * zy + cy;
    zx = nx;
    i++;
  }
  return Math.floor((i / max) * 65535);
}

export async function streamMockRaster(
  ws: WebSocket,
  p: RasterParams
): Promise<void> {
  const total = p.resolution * p.resolution;
  const pixelsPerChunk = Math.max(
    1,
    Math.floor(p.latency_bytes / Math.max(1, p.dwell))
  );

  let sent = 0;
  let chunks = 0;

  while (sent < total) {
    if (ws.readyState !== ws.OPEN) return;

    const n = Math.min(pixelsPerChunk, total - sent);
    const buf = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) {
      const idx = sent + k;
      const x = idx % p.resolution;
      const y = Math.floor(idx / p.resolution);
      const v = pixelValue(x, y, p.resolution);
      // HIGH byte first, then LOW — matches FPGA ImageSerializer order.
      buf[k * 2] = (v >> 8) & 0xff;
      buf[k * 2 + 1] = v & 0xff;
    }
    ws.send(buf);
    sent += n;
    chunks++;

    // Throttle to a believable rate. Real hardware caps out somewhere
    // around a few MB/s; we aim for ~30 chunks/sec so the UI animates.
    await sleep(30);
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "done", chunks }));
  }
}

export async function streamMockVector(
  ws: WebSocket,
  p: VectorParams
): Promise<void> {
  // Default pattern: synthesise edge² points in the same (x, y) order
  // the real FPGA emits, scaled by stride = 2048 / edge so coverage
  // matches a real default sweep. Custom: replay the client's points.
  let pts: Array<[number, number, number]>;
  if (p.pattern === "custom" && p.points && p.points.length) {
    pts = p.points;
  } else {
    const edge = p.vector_resolution ?? 2048;
    const stride = Math.max(1, Math.floor(2048 / edge));
    pts = new Array(edge * edge);
    for (let x = 0; x < edge; x++) {
      for (let y = 0; y < edge; y++) {
        pts[x * edge + y] = [x * stride, y * stride, 1];
      }
    }
  }

  const valuesPerChunk = Math.max(64, Math.floor(p.latency_bytes / 4));
  let i = 0;
  let chunks = 0;

  while (i < pts.length) {
    if (ws.readyState !== ws.OPEN) return;
    const slice = pts.slice(i, i + valuesPerChunk);
    // 4 uint16 per point: x, y, dwell, value (synthetic pixel reading)
    const buf = Buffer.alloc(slice.length * 4 * 2);
    for (let k = 0; k < slice.length; k++) {
      const [x, y, d] = slice[k];
      const v = ((x ^ y) * 17) & 0xffff;
      const o = k * 8;
      buf.writeUInt16BE(x & 0xffff, o + 0);
      buf.writeUInt16BE(y & 0xffff, o + 2);
      buf.writeUInt16BE(d & 0xffff, o + 4);
      buf.writeUInt16BE(v, o + 6);
    }
    ws.send(buf);
    i += valuesPerChunk;
    chunks++;
    await sleep(40);
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "done", chunks }));
  }
}

/** Synthetic responses for the REST endpoints, when MOCK=1. */
export const mockRest = {
  status() {
    return {
      state: "idle",
      last_error: null,
      scans_completed: 0,
      chunks_in_flight: 0,
    };
  },
  defaults() {
    return {
      raster: {
        resolution: 512,
        dwell: 2,
        latency: 16384,
        frameBlank: false,
      },
      vector: {
        latency: 8196,
        outputMode: "SixteenBit",
        drainFloorPixels: 128,
      },
    };
  },
  runRaster(req: RasterParams & { do_validate?: boolean }) {
    const total = req.resolution * req.resolution;
    const pixelsPerChunk = Math.max(1, Math.floor(req.latency_bytes / Math.max(1, req.dwell)));
    const expected = Math.ceil(total / pixelsPerChunk);
    // Cache so /scan/last/* mock endpoints have something to return.
    mockLastScan = {
      kind: "raster",
      resolution: req.resolution,
      latency_bytes: req.latency_bytes,
      source: "validated",
    };
    return {
      kind: "raster",
      chunks: expected,
      bytes: total * 2,
      resolution: req.resolution,
      dwell: req.dwell,
      expected_chunks: expected,
      pixels_per_chunk: pixelsPerChunk,
      send_time_s: total / 1_500_000,
      has_data: true,
      validation: req.do_validate
        ? {
            passed: true,
            checks: [
              { name: "chunk_count", passed: true, detail: `expected ${expected}, got ${expected}` },
              { name: "full_chunk_sizes", passed: true, detail: `all non-tail chunks = ${pixelsPerChunk * 2} bytes` },
              { name: "tail_chunk_size", passed: true, detail: "tail OK" },
              { name: "no_padding_leak", passed: true, detail: "chunk 2 OK" },
            ],
          }
        : null,
    };
  },
  runVector(req: VectorParams & { do_validate?: boolean; pre_process?: boolean }) {
    // Default-pattern total samples = edge². Custom-pattern uses the
    // provided point list. Pick valuesPerChunk to match what the WS
    // streamer would produce (latency_bytes / 4 per the synthetic
    // 4-uint16-per-point format we still emit there).
    let totalSamples: number;
    if (req.pattern === "custom" && req.points) {
      totalSamples = req.points.length;
    } else {
      const edge = req.vector_resolution ?? 2048;
      totalSamples = edge * edge;
    }
    const valuesPerChunk = Math.max(64, Math.floor(req.latency_bytes / 4));
    const chunks = Math.max(1, Math.ceil(totalSamples / valuesPerChunk));
    mockLastScan = {
      kind: "vector",
      latency_bytes: req.latency_bytes,
      pattern: req.pattern,
      vector_resolution: req.vector_resolution,
      source: "validated",
    };
    return {
      kind: "vector",
      chunks,
      bytes: chunks * req.latency_bytes,
      process_time_s: req.pre_process ? 0.012 : null,
      send_time_s: 0.4,
      has_data: true,
      validation: req.do_validate
        ? {
            passed: true,
            checks: [
              { name: "non_zero_chunks", passed: true, detail: `received ${chunks} chunks` },
              { name: "all_chunks_non_empty", passed: true, detail: "all non-empty" },
              { name: "no_padding_leak", passed: true, detail: "chunk 2 OK" },
            ],
          }
        : null,
    };
  },
  lastMeta() {
    return mockLastScan;
  },
  /** Generate a tiny synthetic CSV so the download button works in MOCK
   *  mode. Real shape would be res*res numbers; we emit just a 4x4 grid
   *  to keep the demo fast. The button still works end-to-end. */
  lastCsv(): { filename: string; body: string } | null {
    if (!mockLastScan) return null;
    const rows: string[] = [];
    for (let r = 0; r < 4; r++) {
      const row: number[] = [];
      for (let c = 0; c < 4; c++) row.push((r * 17 + c * 31) & 0xffff);
      rows.push(row.join(" "));
    }
    const filename =
      mockLastScan.kind === "raster"
        ? `raster_${mockLastScan.resolution}x${mockLastScan.resolution}.csv`
        : `vector_latency${mockLastScan.latency_bytes}.csv`;
    return { filename, body: rows.join("\r\n") + "\r\n" };
  },
};

/** Module-level state for the mock /scan/last/* endpoints. */
let mockLastScan:
  | {
      kind: "raster" | "vector";
      resolution?: number;
      latency_bytes?: number;
      pattern?: string;
      vector_resolution?: number;
      source: "validated" | "stream";
    }
  | null = null;
