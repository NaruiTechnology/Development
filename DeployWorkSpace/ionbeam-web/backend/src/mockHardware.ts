/**
 * Mock hardware. Used when MOCK=1 — generates the same byte format the
 * FastAPI service emits, so the front-end has exactly one code path to
 * handle real and synthetic data.
 *
 * Format reminder (matches glasgow_service.service.{raster,vector}_scan):
 *
 *   Each WS frame is bytes(chunk) where chunk is a uint16 ADC-sample array.
 *   The FPGA ImageSerializer emits HIGH byte first then LOW byte for every
 *   sample. Vector samples do NOT carry inline x/y/dwell fields; the UI
 *   reconstructs coordinates from the submitted vector script.
 *
 * Termination message is the same JSON the FastAPI service sends:
 *   {"event":"done","chunks":N}
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { WebSocket } from "ws";

import { config } from "./config";

interface RasterParams {
  resolution: number;
  dwell: number;
  latency_bytes: number;
  cookie?: number;
  frame_blank?: boolean;
  simulation_bitmap?: SimulationBitmapPayload | null;
}

interface VectorParams {
  pattern: "default" | "custom";
  points?: Array<[number, number, number]>;
  latency_bytes: number;
  /** Edge length for default-pattern sweeps (256 / 512 / 1024 / 2048).
   *  Total samples = edge². Coverage is always the full DAC range. */
  vector_resolution?: number;
  roi?: { x_start: number; x_end: number; y_start: number; y_end: number } | null;
  simulation_bitmap?: SimulationBitmapPayload | null;
}

interface SimulationBitmapPayload {
  width: number;
  height: number;
  pixels: number[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DAC_BITS = 14;
const ADC_MAX = (1 << DAC_BITS) - 1;

interface SimulationImage {
  resolution: number;
  pixels: Uint8Array;
}

let cachedSimulationImage: SimulationImage | null = null;

function loadSimulationImage(): SimulationImage {
  if (cachedSimulationImage) return cachedSimulationImage;

  const sim = loadActionData().simulation ?? {};
  const resolution = validateImageResolution(Number(sim?.imageResolution ?? 64));
  const source = String(sim?.source ?? "pattern");

  if (source === "random") {
    cachedSimulationImage = {
      resolution,
      pixels: randomImage(resolution, Number(sim?.seed ?? 1)),
    };
    return cachedSimulationImage;
  }

  if (source === "file") {
    const filePath = sim?.filePath ?? sim?._alt_file?.path ?? sim?.path;
    const loaded = typeof filePath === "string"
      ? loadImageFile(filePath, resolution, Boolean(sim?.invert ?? sim?._alt_file?.invert))
      : null;
    if (loaded) {
      cachedSimulationImage = loaded;
      return cachedSimulationImage;
    }
  }

  // Pattern fallback keeps MOCK=1 on the current FakeAdcSimulator DAC
  // mapping even when the configured file cannot be decoded locally.
  cachedSimulationImage = {
    resolution,
    pixels: patternImage(resolution, String(sim?.patternKind ?? "ramp")),
  };
  return cachedSimulationImage;
}

function streamDataConfigPath(): string {
  return process.env.STREAM_DATA_JSON?.trim() || config.configPath;
}

function loadStreamDataConfig(): any {
  try {
    const raw = fs.readFileSync(streamDataConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadActionData(): any {
  return actionDataFromConfig(loadStreamDataConfig());
}

function actionDataFromConfig(parsed: any): any {
  const states = parsed?.Actions ?? parsed?.WorkStates ?? parsed?.workStates ?? parsed?.states ?? [];
  const streamData = Array.isArray(states)
    ? states.find((s: any) => s?.streamData || s?.name === "streamData" || s?.Name === "streamData")
    : null;
  return (
    streamData?.streamData?.actionData ??
    streamData?.actionData ??
    streamData?.ActionData ??
    streamData?.action_data ??
    parsed?.actionData ??
    {}
  );
}

function validateImageResolution(value: number): number {
  if (Number.isInteger(value) && value >= 16 && value <= 256 && (value & (value - 1)) === 0) {
    return value;
  }
  return 64;
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function patternImage(resolution: number, kind: string): Uint8Array {
  const out = new Uint8Array(resolution * resolution);
  if (kind === "checker") {
    const cell = Math.max(1, Math.floor(resolution / 8));
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        out[y * resolution + x] = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ? 255 : 0;
      }
    }
  } else if (kind === "bars") {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        out[y * resolution + x] = Math.floor((x * 8) / resolution) * 32;
      }
    }
  } else if (kind === "bullseye") {
    const c = (resolution - 1) / 2;
    const maxR = Math.sqrt(c * c + c * c);
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const r = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c));
        out[y * resolution + x] = Math.max(0, Math.floor(255 * (1 - r / maxR)));
      }
    }
  } else {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        out[y * resolution + x] = Math.floor((x * 255) / (resolution - 1));
      }
    }
  }
  return out;
}

function randomImage(resolution: number, seed: number): Uint8Array {
  const out = new Uint8Array(resolution * resolution);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < out.length; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function loadImageFile(filePath: string, resolution: number, invert: boolean): SimulationImage | null {
  if (!fs.existsSync(filePath)) return null;

  const script = [
    "import json, sys",
    "from PIL import Image",
    "path=sys.argv[1]",
    "res=int(sys.argv[2])",
    "invert=sys.argv[3].lower() in ('1','true','yes','on')",
    "im=Image.open(path).convert('L').resize((res,res), resample=Image.Resampling.NEAREST)",
    "px=list(im.getdata())",
    "if invert: px=[255-v for v in px]",
    "json.dump(px, sys.stdout)",
  ].join("; ");

  const pythonCommands =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
          { command: "python3", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];

  let stdout: string | null = null;
  for (const { command, args } of pythonCommands) {
    const result = spawnSync(
      command,
      [...args, "-c", script, filePath, String(resolution), String(invert)],
      {
        encoding: "utf8",
        maxBuffer: resolution * resolution * 8,
      }
    );
    if (result.status === 0 && result.stdout) {
      stdout = result.stdout;
      break;
    }
  }
  if (!stdout) return null;

  try {
    const data = JSON.parse(stdout);
    if (!Array.isArray(data) || data.length !== resolution * resolution) return null;
    return { resolution, pixels: Uint8Array.from(data.map((v) => Number(v) & 0xff)) };
  } catch {
    return null;
  }
}

function sampleFakeAdc(dacX: number, dacY: number): number {
  const img = loadSimulationImage();
  const bits = Math.log2(img.resolution);
  const shift = DAC_BITS - bits;
  const xIdx = Math.max(0, Math.min(img.resolution - 1, dacX >> shift));
  const yIdx = Math.max(0, Math.min(img.resolution - 1, dacY >> shift));
  return Math.min(img.pixels[yIdx * img.resolution + xIdx] * 64, ADC_MAX);
}

function sampleSimulationBitmap(
  bitmap: SimulationBitmapPayload,
  xNorm: number,
  yNorm: number
): number {
  const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(xNorm * (bitmap.width - 1))));
  const y = Math.max(0, Math.min(bitmap.height - 1, Math.round(yNorm * (bitmap.height - 1))));
  const px = bitmap.pixels[y * bitmap.width + x] ?? 0;
  return Math.min(Math.max(0, Number(px) & 0xff) * 64, ADC_MAX);
}

function sampleSimulationBitmapPoint(
  bitmap: SimulationBitmapPayload,
  roi: VectorParams["roi"],
  x: number,
  y: number
): number {
  if (!roi) return sampleSimulationBitmap(bitmap, x / ADC_MAX, y / ADC_MAX);
  const x0 = Math.min(roi.x_start, roi.x_end);
  const x1 = Math.max(roi.x_start, roi.x_end);
  const y0 = Math.min(roi.y_start, roi.y_end);
  const y1 = Math.max(roi.y_start, roi.y_end);
  return sampleSimulationBitmap(
    bitmap,
    (x - x0) / Math.max(1, x1 - x0),
    (y - y0) / Math.max(1, y1 - y0)
  );
}

function writeSampleBE(buf: Buffer, sampleIndex: number, value: number): void {
  const o = sampleIndex * 2;
  buf[o] = (value >> 8) & 0xff;
  buf[o + 1] = value & 0xff;
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
      const dacX = Math.floor((x * (1 << DAC_BITS)) / p.resolution);
      const dacY = Math.floor((y * (1 << DAC_BITS)) / p.resolution);
      const sample = p.simulation_bitmap
        ? sampleSimulationBitmap(
            p.simulation_bitmap,
            p.resolution <= 1 ? 0 : x / (p.resolution - 1),
            p.resolution <= 1 ? 0 : y / (p.resolution - 1)
          )
        : sampleFakeAdc(dacX, dacY);
      writeSampleBE(buf, k, sample);
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
  // Default pattern: synthesise edge² 14-bit DAC points in the same
  // (x, y) order the real FPGA emits. Custom replays the client's
  // already-14-bit DAC tuples.
  let pts: Array<[number, number, number]>;
  if (p.pattern === "custom" && p.points && p.points.length) {
    pts = p.points;
  } else if (p.pattern === "custom" && p.simulation_bitmap) {
    const bitmap = p.simulation_bitmap;
    pts = new Array(bitmap.width * bitmap.height);
    for (let x = 0; x < bitmap.width; x++) {
      for (let y = 0; y < bitmap.height; y++) {
        pts[x * bitmap.height + y] = [x, y, 1];
      }
    }
  } else {
    const edge = p.vector_resolution ?? 2048;
    const stride = Math.max(1, Math.floor((1 << DAC_BITS) / edge));
    pts = new Array(edge * edge);
    for (let x = 0; x < edge; x++) {
      for (let y = 0; y < edge; y++) {
        pts[x * edge + y] = [x * stride, y * stride, 1];
      }
    }
  }

  const valuesPerChunk = Math.max(64, Math.floor(p.latency_bytes / 2));
  let i = 0;
  let chunks = 0;

  while (i < pts.length) {
    if (ws.readyState !== ws.OPEN) return;
    const slice = pts.slice(i, i + valuesPerChunk);
    const buf = Buffer.alloc(slice.length * 2);
    for (let k = 0; k < slice.length; k++) {
      const [x, y] = slice[k];
      const sample = p.simulation_bitmap
        ? p.pattern !== "custom" || (p.points && p.points.length)
          ? sampleSimulationBitmapPoint(p.simulation_bitmap, p.roi, x, y)
          : sampleSimulationBitmap(
              p.simulation_bitmap,
              p.simulation_bitmap.width <= 1 ? 0 : x / (p.simulation_bitmap.width - 1),
              p.simulation_bitmap.height <= 1 ? 0 : y / (p.simulation_bitmap.height - 1)
            )
        : sampleFakeAdc(x, y);
      writeSampleBE(buf, k, sample);
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
    const streamDataConfig = loadStreamDataConfig();
    const action = actionDataFromConfig(streamDataConfig);
    const raster = action.rasterScan ?? {};
    const vector = action.vectorScan ?? {};
    const selectedBeam = action.enableEbeam ? "ebeam" : "ion";
    return {
      is_production: false,
      simulation: action.simulation ?? {},
      raster: {
        ...raster,
        resolution: finiteNumber(raster.resolution, 512),
        dwell: finiteNumber(raster.dwell, 2),
        latency: finiteNumber(raster.latency, finiteNumber(raster.pixels, 8192) * 2),
        frameBlank: Boolean(raster.frameBlank ?? false),
      },
      vector: {
        ...vector,
        latency: finiteNumber(vector.latency, 8196),
        outputMode: vector.outputMode ?? "SixteenBit",
      },
      selected_beam: selectedBeam,
      version: typeof streamDataConfig.Version === "string" ? streamDataConfig.Version : "",
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
            ],
          }
        : null,
    };
  },
  runVector(req: VectorParams & { do_validate?: boolean; pre_process?: boolean }) {
    // Default-pattern total samples = edge². Custom-pattern uses the
    // provided point list. Pick valuesPerChunk to match what the WS
    // streamer would produce (2 bytes per ADC sample).
    let totalSamples: number;
    if (req.pattern === "custom" && req.points) {
      totalSamples = req.points.length;
    } else {
      const edge = req.vector_resolution ?? 2048;
      totalSamples = edge * edge;
    }
    const valuesPerChunk = Math.max(64, Math.floor(req.latency_bytes / 2));
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
    const ts = shortTimestampSuffix();
    const filename =
      mockLastScan.kind === "raster"
        ? `raster_${mockLastScan.resolution}x${mockLastScan.resolution}_${ts}.csv`
        : `vector_latency_${mockLastScan.latency_bytes}_${ts}.csv`;
    return { filename, body: rows.join("\r\n") + "\r\n" };
  },
};

function shortTimestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

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
