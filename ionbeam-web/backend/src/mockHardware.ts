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

type VectorPointTuple =
  | [number, number, number]
  | [number, number, number, boolean | null]
  | [number, number, number, boolean | null, number | null];

type VectorPointObject = {
  x: number;
  y: number;
  dwell: number;
  blank?: boolean | null;
  passIndex?: number | null;
};

interface RasterParams {
  resolution: number;
  dwell: number;
  latency_bytes: number;
  voltage?: number;
  cookie?: number;
  frame_blank?: boolean;
  simulation_bitmap?: SimulationBitmapPayload | null;
  parallel_rois?: Array<{ x_start: number; x_end: number; y_start: number; y_end: number }> | null;
  roi?: { x_start: number; x_end: number; y_start: number; y_end: number } | null;
  getGeometry?: () => Pick<RasterParams, "roi" | "parallel_rois">;
  parallel_simulation_bitmaps?: SimulationBitmapPayload[] | null;
  simulation?: Record<string, unknown>;
  /** Live (Infinite) scan: repeat frames until the client closes. */
  continuous?: boolean;
  /** Repeat N: with continuous, stop after this many frames. */
  frames?: number | null;
}

interface VectorParams {
  pattern: "default" | "custom";
  scan_path?: VectorScanPath;
  points?: Array<VectorPointTuple | VectorPointObject>;
  dwell: number;
  latency_bytes: number;
  voltage?: number;
  /** Edge length for default-pattern sweeps (1..2048).
   *  Total samples = edge². Coverage is always the full DAC range. */
  vector_resolution?: number;
  roi?: { x_start: number; x_end: number; y_start: number; y_end: number } | null;
  parallel_rois?: Array<{ x_start: number; x_end: number; y_start: number; y_end: number }> | null;
  getGeometry?: () => Pick<VectorParams, "roi" | "parallel_rois" | "points">;
  parallel_simulation_bitmaps?: SimulationBitmapPayload[] | null;
  simulation_bitmap?: SimulationBitmapPayload | null;
  target_gray_level?: number | null;
  simulation?: Record<string, unknown>;
  /** Live (Infinite) scan: replay the pass until the client closes. */
  continuous?: boolean;
  /** Repeat N: with continuous, stop after this many passes. */
  frames?: number | null;
}

type VectorScanPath =
  | "vertical_raster"
  | "vertical_serpentine"
  | "horizontal_sawtooth"
  | "horizontal_triangle";

interface SimulationBitmapPayload {
  width: number;
  height: number;
  pixels: Array<number | SimulationBitmapPixel>;
  source_roi?: { x_start: number; x_end: number; y_start: number; y_end: number } | null;
}

interface SimulationBitmapPixel {
  value: number;
  isHighlighted?: boolean | null;
  isSkipped?: boolean | null;
  blank?: boolean | null;
}

function stepTargetBitmap(
  bitmap: SimulationBitmapPayload,
  region: VectorParams["roi"],
  target: number,
): void {
  const source = bitmap.source_roi ?? { x_start: 0, x_end: ADC_MAX, y_start: 0, y_end: ADC_MAX };
  const selected = region ?? source;
  const x0 = Math.max(0, Math.floor(((Math.min(selected.x_start, selected.x_end) - source.x_start) / Math.max(1, source.x_end - source.x_start)) * bitmap.width));
  const x1 = Math.min(bitmap.width, Math.ceil(((Math.max(selected.x_start, selected.x_end) - source.x_start) / Math.max(1, source.x_end - source.x_start)) * bitmap.width));
  const y0 = Math.max(0, Math.floor(((Math.min(selected.y_start, selected.y_end) - source.y_start) / Math.max(1, source.y_end - source.y_start)) * bitmap.height));
  const y1 = Math.min(bitmap.height, Math.ceil(((Math.max(selected.y_start, selected.y_end) - source.y_start) / Math.max(1, source.y_end - source.y_start)) * bitmap.height));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const index = y * bitmap.width + x;
    const pixel = bitmap.pixels[index];
    const value = typeof pixel === "number" ? pixel : pixel.value;
    if (value <= target) continue;
    const next = Math.max(target, value - 2);
    bitmap.pixels[index] = typeof pixel === "number" ? next : {
      ...pixel, value: next,
      ...(next <= target ? { isHighlighted: true, isSkipped: true, blank: true } : {}),
    };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DAC_BITS = 14;
const ADC_MAX = (1 << DAC_BITS) - 1;

interface SimulationImage {
  resolution: number;
  pixels: Uint8Array;
}

let cachedSimulationImage: SimulationImage | null = null;

function loadSimulationImage(override?: Record<string, unknown>): SimulationImage {
  if (!override && cachedSimulationImage) return cachedSimulationImage;

  const sim = override ?? loadActionData().simulation ?? {};
  const resolution = validateImageResolution(Number(sim?.imageResolution ?? 64));
  const source = String(sim?.source ?? "pattern");

  if (source === "random") {
    const image = {
      resolution,
      pixels: randomImage(resolution, Number(sim?.seed ?? 1)),
    };
    if (!override) cachedSimulationImage = image;
    return image;
  }

  if (source === "file") {
    const filePath = sim?.filePath ?? sim?._alt_file?.path ?? sim?.path;
    const loaded = typeof filePath === "string"
      ? loadImageFile(filePath, resolution, Boolean(sim?.invert ?? sim?._alt_file?.invert))
      : null;
    if (loaded) {
      if (!override) cachedSimulationImage = loaded;
      return loaded;
    }
  }

  // Pattern fallback keeps MOCK=1 on the current FakeAdcSimulator DAC
  // mapping even when the configured file cannot be decoded locally.
  const image = {
    resolution,
    pixels: patternImage(resolution, String(sim?.patternKind ?? "ramp")),
  };
  if (!override) cachedSimulationImage = image;
  return image;
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

  const result = spawnSync("python3", ["-c", script, filePath, String(resolution), String(invert)], {
    encoding: "utf8",
    maxBuffer: resolution * resolution * 8,
  });
  if (result.status !== 0 || !result.stdout) return null;

  try {
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data) || data.length !== resolution * resolution) return null;
    return { resolution, pixels: Uint8Array.from(data.map((v) => Number(v) & 0xff)) };
  } catch {
    return null;
  }
}

function sampleFakeAdc(
  dacX: number,
  dacY: number,
  simulation: Record<string, unknown>,
  img: SimulationImage,
): number {
  const mode = String(simulation.mode ?? "image").toLowerCase();
  if (mode === "zeros") return 0;
  if (mode === "loopback") return dacX & ADC_MAX;
  const bits = Math.log2(img.resolution);
  const shift = DAC_BITS - bits;
  const xIdx = Math.max(0, Math.min(img.resolution - 1, dacX >> shift));
  const yIdx = Math.max(0, Math.min(img.resolution - 1, dacY >> shift));
  return Math.min(img.pixels[yIdx * img.resolution + xIdx] * 64, ADC_MAX);
}

function sampleSimulationBitmap(
  bitmap: SimulationBitmapPayload,
  xNorm: number,
  yNorm: number,
  mode: "skip" | "spot" | null,
  rawTarget = false,
): number {
  const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(xNorm * (bitmap.width - 1))));
  const y = Math.max(0, Math.min(bitmap.height - 1, Math.round(yNorm * (bitmap.height - 1))));
  const px = bitmap.pixels[y * bitmap.width + x];
  return rawTarget ? Math.min(Math.max(0, pixelValue(px) & 0xff) * 64, ADC_MAX) : sampleBitmapPixel(px, mode);
}

function sampleSimulationBitmapPoint(
  bitmap: SimulationBitmapPayload,
  roi: VectorParams["roi"],
  x: number,
  y: number,
  mode: "skip" | "spot" | null,
  rawTarget = false,
): number {
  roi = bitmap.source_roi ?? roi;
  if (!roi) return sampleSimulationBitmap(bitmap, x / ADC_MAX, y / ADC_MAX, mode, rawTarget);
  const x0 = Math.min(roi.x_start, roi.x_end);
  const x1 = Math.max(roi.x_start, roi.x_end);
  const y0 = Math.min(roi.y_start, roi.y_end);
  const y1 = Math.max(roi.y_start, roi.y_end);
  return sampleSimulationBitmap(
    bitmap,
    (x - x0) / Math.max(1, x1 - x0),
    (y - y0) / Math.max(1, y1 - y0),
    mode,
    rawTarget,
  );
}

function pixelValue(pixel: number | SimulationBitmapPixel | undefined): number {
  if (typeof pixel === "number") return pixel;
  if (!pixel) return 0;
  return Number(pixel.value) || 0;
}

function isHighlightedPixel(pixel: number | SimulationBitmapPixel | undefined): boolean {
  if (typeof pixel === "number" || !pixel) return false;
  return Boolean(pixel.isHighlighted);
}

function isSkippedPixel(pixel: number | SimulationBitmapPixel | undefined): boolean | null {
  if (typeof pixel === "number" || !pixel) return null;
  if (pixel.isSkipped === null || pixel.isSkipped === undefined) return null;
  return Boolean(pixel.isSkipped);
}

function inferBitmapMode(bitmap: SimulationBitmapPayload): "skip" | "spot" | null {
  let sawSkip = false;
  let sawSpot = false;
  let sawLegacyHighlight = false;
  for (const pixel of bitmap.pixels) {
    if (typeof pixel === "number" || !pixel) continue;
    if (pixel.isSkipped === true) sawSkip = true;
    else if (pixel.isSkipped === false) sawSpot = true;
    if (pixel.isHighlighted) sawLegacyHighlight = true;
  }
  if (sawSpot) return "spot";
  if (sawSkip || sawLegacyHighlight) return "skip";
  return null;
}

function sampleBitmapPixel(
  pixel: number | SimulationBitmapPixel | undefined,
  mode: "skip" | "spot" | null
): number {
  const value = Math.min(Math.max(0, pixelValue(pixel) & 0xff) * 64, ADC_MAX);
  const skipped = isSkippedPixel(pixel);
  const legacyHighlight = isHighlightedPixel(pixel);

  if (mode === "skip") {
    return skipped === true || (skipped === null && legacyHighlight) ? 0 : value;
  }
  if (mode === "spot") {
    return skipped === false ? value : 0;
  }
  return skipped === true || legacyHighlight ? 0 : value;
}

function normalizeVectorPoint(
  point: VectorPointTuple | VectorPointObject
): [number, number, number, boolean | null, number | null] {
  if (Array.isArray(point)) {
    const arr = point as [number, number, number] & { 3?: boolean | null; 4?: number | null };
    const blank = arr.length >= 4 && arr[3] !== undefined && arr[3] !== null ? Boolean(arr[3]) : null;
    const passIndex = arr.length >= 5 && arr[4] !== undefined && arr[4] !== null ? Number(arr[4]) | 0 : null;
    return [Number(arr[0]) | 0, Number(arr[1]) | 0, Number(arr[2]) | 0, blank, passIndex];
  }
  return [
    Number(point.x) | 0,
    Number(point.y) | 0,
    Number(point.dwell) | 0,
    point.blank === null || point.blank === undefined ? null : Boolean(point.blank),
    point.passIndex === null || point.passIndex === undefined ? null : Number(point.passIndex) | 0,
  ];
}

// Scan samples are OBI-aligned like the real gateware sends them: the 14-bit
// code left-aligned in 16 bits (code << 2, full scale 0xfffc). The ADC-only
// test mock (wsProxy.ts) stays raw 14-bit because the real ADC-only gateware is.
const OBI_SAMPLE_SHIFT = 2;

function writeSampleBE(buf: Buffer, sampleIndex: number, raw14: number): void {
  const value = raw14 << OBI_SAMPLE_SHIFT;
  const o = sampleIndex * 2;
  buf[o] = (value >> 8) & 0xff;
  buf[o + 1] = value & 0xff;
}

export async function streamMockRaster(
  ws: WebSocket,
  p: RasterParams
): Promise<void> {
  const regionLength = p.resolution * p.resolution;
  const regionCount = p.parallel_rois?.length ?? 1;
  const total = regionLength * regionCount;
  const pixelsPerChunk = Math.max(
    1,
    Math.floor(p.latency_bytes / Math.max(1, p.dwell))
  );

  let sent = 0;
  let chunks = 0;
  const simulation = p.simulation ?? loadActionData().simulation ?? {};
  const simulationImage = loadSimulationImage(p.simulation);

  const frameLimit = p.continuous === true && p.frames ? Math.max(1, Math.trunc(p.frames)) : null;
  let framesDone = 0;
  let activeGeometry = p.getGeometry?.() ?? p;
  while (sent < total || p.continuous === true) {
    if (ws.readyState !== ws.OPEN) return;
    // Live scan: wrap to the next frame on the same socket (Stop closes it).
    if (sent >= total) {
      framesDone++;
      if (frameLimit !== null && framesDone >= frameLimit) break;
      sent = 0;
      activeGeometry = p.getGeometry?.() ?? p;
    }

    const n = Math.min(pixelsPerChunk, total - sent);
    const buf = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) {
      const idx = sent + k;
      // Hardware visits one sample from every ROI in turn. Keep simulated
      // streams in that order so the renderer routes samples to matching ROIs.
      const regionIndex = idx % regionCount;
      const localIndex = Math.floor(idx / regionCount);
      const x = localIndex % p.resolution;
      const y = Math.floor(localIndex / p.resolution);
      const roi = activeGeometry.parallel_rois?.[regionIndex] ?? activeGeometry.roi;
      const dacX = roi
        ? Math.round(roi.x_start + (x / Math.max(1, p.resolution - 1)) * (roi.x_end - roi.x_start))
        : Math.floor((x * (1 << DAC_BITS)) / p.resolution);
      const dacY = roi
        ? Math.round(roi.y_start + (y / Math.max(1, p.resolution - 1)) * (roi.y_end - roi.y_start))
        : Math.floor((y * (1 << DAC_BITS)) / p.resolution);
      const bitmap = p.parallel_simulation_bitmaps?.[regionIndex] ?? p.simulation_bitmap;
      const sample = bitmap
        ? sampleSimulationBitmap(
            bitmap,
            p.resolution <= 1 ? 0 : x / (p.resolution - 1),
            p.resolution <= 1 ? 0 : y / (p.resolution - 1),
            inferBitmapMode(bitmap)
          )
        : sampleFakeAdc(dacX, dacY, simulation, simulationImage);
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
    const ts = shortTimestampSuffix();
    ws.send(
      JSON.stringify({
        event: "done",
        chunks,
        csv_filename: `raster_${p.resolution}x${p.resolution}_${ts}.csv`,
        image_filename: `raster_${p.resolution}x${p.resolution}_${ts}.png`,
      }),
    );
  }
}

export async function streamMockVector(
  ws: WebSocket,
  p: VectorParams
): Promise<void> {
  // Default pattern: synthesise edge² 14-bit DAC points in the same
  // (x, y) order the real FPGA emits. Custom replays the client's
  // already-14-bit DAC tuples.
  let pts: Array<VectorPointTuple | VectorPointObject> | null = null;
  let pointCount: number;
  let makePointIterator: () => Iterator<VectorPointTuple | VectorPointObject>;
  if (p.pattern === "custom" && p.points && p.points.length) {
    pts = p.points;
    pointCount = pts.length;
    makePointIterator = () => (p.getGeometry?.().points ?? pts!)[Symbol.iterator]();
  } else if (p.pattern === "custom" && p.simulation_bitmap) {
    const bitmap = p.simulation_bitmap;
    pointCount = bitmap.width * bitmap.height;
    makePointIterator = function* () {
      for (let x = 0; x < bitmap.width; x++) {
        for (let y = 0; y < bitmap.height; y++) yield [x, y, 1] as VectorPointTuple;
      }
    };
  } else {
    const edge = Math.max(1, Math.trunc(p.vector_resolution ?? 1024));
    pointCount = edge * edge * (p.parallel_rois?.length ?? 1);
    makePointIterator = () => {
      const geometry = p.getGeometry?.() ?? p;
      const updated = { ...p, ...geometry };
      return geometry.parallel_rois?.length
        ? interleaveVectorScanPoints(updated, geometry.parallel_rois)
        : vectorScanPointIterator(updated);
    };
  }

  const valuesPerChunk = Math.max(64, Math.floor(p.latency_bytes / 2));
  let i = 0;
  let chunks = 0;
  const simulation = p.simulation ?? loadActionData().simulation ?? {};
  const simulationImage = loadSimulationImage(p.simulation);

  const passLimit = p.continuous === true && p.frames ? Math.max(1, Math.trunc(p.frames)) : null;
  let passesDone = 0;
  let pointIterator = makePointIterator();
  let activeGeometry = p.getGeometry?.() ?? p;
  while (i < pointCount || (p.continuous === true && pointCount > 0)) {
    if (ws.readyState !== ws.OPEN) return;
    // Live scan: wrap to the next pass on the same socket (Stop closes it).
    if (i >= pointCount) {
      passesDone++;
      if (passLimit !== null && passesDone >= passLimit) break;
      if (p.target_gray_level !== null && p.target_gray_level !== undefined) {
        if (p.parallel_rois?.length && p.parallel_simulation_bitmaps?.length) {
          p.parallel_simulation_bitmaps.forEach((bitmap, index) => {
            const region = p.parallel_rois?.[index];
            if (index === 0 && p.parallel_rois!.length > 1 && region?.x_start === 0 && region.x_end === ADC_MAX && region.y_start === 0 && region.y_end === ADC_MAX) return;
            stepTargetBitmap(bitmap, region, p.target_gray_level!);
          });
        } else if (p.simulation_bitmap) {
          stepTargetBitmap(p.simulation_bitmap, p.roi, p.target_gray_level);
        }
      }
      i = 0;
      pointIterator = makePointIterator();
      activeGeometry = p.getGeometry?.() ?? p;
    }
    const count = Math.min(valuesPerChunk, pointCount - i);
    const slice = new Array<VectorPointTuple | VectorPointObject>(count);
    for (let k = 0; k < count; k++) slice[k] = pointIterator.next().value!;
    const buf = Buffer.alloc(slice.length * 2);
    for (let k = 0; k < slice.length; k++) {
      const [x, y, , blank, passIndex] = normalizeVectorPoint(slice[k] as any);
      if (passIndex !== null) {
        // Explicit pass markers are preserved in the payload for debugging,
        // but they do not affect the generated sample values.
      }
      const regionIndex = activeGeometry.parallel_rois?.length ? (i + k) % activeGeometry.parallel_rois.length : 0;
      const bitmap = p.parallel_simulation_bitmaps?.[regionIndex] ?? p.simulation_bitmap;
      const sample = bitmap
        ? p.pattern !== "custom" || (p.points && p.points.length)
            ? blank === true && p.target_gray_level == null
            ? 0
            : sampleSimulationBitmapPoint(bitmap, activeGeometry.parallel_rois?.[regionIndex] ?? activeGeometry.roi, x, y, inferBitmapMode(bitmap), p.target_gray_level !== null && p.target_gray_level !== undefined)
          : sampleSimulationBitmap(
              bitmap,
              bitmap.width <= 1 ? 0 : x / (bitmap.width - 1),
              bitmap.height <= 1 ? 0 : y / (bitmap.height - 1),
              inferBitmapMode(bitmap),
              p.target_gray_level !== null && p.target_gray_level !== undefined,
            )
        : sampleFakeAdc(x, y, simulation, simulationImage);
      writeSampleBE(buf, k, sample);
    }
    ws.send(buf);
    i += valuesPerChunk;
    chunks++;
    await sleep(40);
  }

  if (ws.readyState === ws.OPEN) {
    const ts = shortTimestampSuffix();
    const edge = p.pattern === "custom"
      ? Math.max(1, p.points?.length ?? 0)
      : Math.max(1, p.vector_resolution ?? 1024);
    const base = `vector_latency_${p.latency_bytes || edge}`;
    ws.send(
      JSON.stringify({
        event: "done",
        chunks,
        csv_filename: `${base}_${ts}.csv`,
        image_filename: `${base}_${ts}.png`,
      }),
    );
  }
}

export interface DacRampParams {
  axis: "x" | "y";
  fixed_code: number;
  dwell: number;
  latency_bytes: number;
}

/**
 * Mock counterpart of glasgow_service's /scan/dac_ramp/run|/stream:
 * sweeps one DAC axis across the full 14-bit range (0..16383) while the
 * other is held at `fixed_code`, mirroring _build_dac_ramp_cmd's
 * DACCodeRange.from_resolution(16384) + DACCodeRange(count=1). Feeds
 * sampleFakeAdc() the same way streamMockRaster/streamMockVector do, so
 * MOCK=1 renders a plausible waveform for UI development without real
 * hardware — real linearity is only checked on production.
 */
export async function streamMockDacRamp(
  ws: WebSocket,
  p: DacRampParams
): Promise<void> {
  const total = 1 << DAC_BITS; // 16384
  const valuesPerChunk = Math.max(64, Math.floor(p.latency_bytes / 2));
  const fixed = Math.max(0, Math.min(total - 1, Math.trunc(p.fixed_code)));
  const simulation = loadActionData().simulation ?? {};
  const simulationImage = loadSimulationImage();

  let sent = 0;
  let chunks = 0;
  while (sent < total) {
    if (ws.readyState !== ws.OPEN) return;
    const n = Math.min(valuesPerChunk, total - sent);
    const buf = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) {
      const swept = sent + k;
      const dacX = p.axis === "y" ? fixed : swept;
      const dacY = p.axis === "y" ? swept : fixed;
      writeSampleBE(buf, k, sampleFakeAdc(dacX, dacY, simulation, simulationImage));
    }
    ws.send(buf);
    sent += n;
    chunks++;
    await sleep(30);
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "done", chunks }));
  }
}

export interface BeamHoldParams {
  beam: "on" | "blanked";
  dwell: number;
  duration_s: number;
  external_control: boolean;
  /** The scan the hold reproduces; its frames set the duration. */
  match?: { frame_pixels: number; dwell: number; frames?: number; frame_blank?: boolean | null } | null;
}

/**
 * Mock counterpart of glasgow_service's /scan/beam_hold/stream, for UI
 * development without hardware. Streams a parked-beam signal in real time
 * with SYNTHETIC 1.5 ms dark dips every 195 ms (the black-line signature),
 * so the card's dip analysis has something to find. It says nothing about
 * the real instrument.
 */
export async function streamMockBeamHold(
  ws: WebSocket,
  p: BeamHoldParams,
): Promise<void> {
  const conversionHz = 8_000_000;
  const dwell = Math.max(0, Math.min(65535, Math.trunc(p.dwell)));
  const periodUs = ((dwell + 1) * 1e6) / conversionHz;
  const m = p.match;
  const durationS = m && Number(m.frame_pixels) > 0
    ? (Math.max(1, Math.trunc(Number(m.frames) || 1)) * Number(m.frame_pixels) * (Math.trunc(Number(m.dwell) || 0) + 1)) / conversionHz
    : Math.max(0.1, Math.min(600, Number(p.duration_s) || 30));
  ws.send(JSON.stringify({
    event: "metadata",
    sample_period_us: periodUs,
    conversion_hz: conversionHz,
    duration_s: durationS,
    beam: p.beam,
    external_control: p.external_control,
    mock: true,
  }));

  const tickMs = 20;
  const perTick = Math.max(1, Math.round((tickMs * 1000) / periodUs));
  const total = Math.round((durationS * 1e6) / periodUs);
  const level = p.beam === "blanked" ? 600 : 9000;
  let sent = 0;
  let chunks = 0;
  let noise = 12345;
  while (sent < total) {
    if (ws.readyState !== ws.OPEN) return;
    const n = Math.min(perTick, total - sent);
    const buf = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) {
      const tMs = ((sent + k) * periodUs) / 1000;
      const inDip = tMs % 195 >= 50 && tMs % 195 < 51.5;
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const value = (inDip ? 300 : level) + ((noise >> 16) % 160) - 80;
      writeSampleBE(buf, k, Math.max(0, Math.min(16383, value)));
    }
    ws.send(buf);
    sent += n;
    chunks++;
    await sleep(tickMs);
  }
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: "done", chunks }));
  }
}

function vectorScanPoints(p: VectorParams): VectorPointTuple[] {
  return Array.from(vectorScanPointIterator(p));
}

function* interleaveVectorScanPoints(
  p: VectorParams,
  rois: NonNullable<VectorParams["parallel_rois"]>,
): Generator<VectorPointTuple> {
  const iterators = rois.map((roi) => vectorScanPointIterator({ ...p, roi }));
  while (true) {
    for (const iterator of iterators) {
      const next = iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
}

function* vectorScanPointIterator(p: VectorParams): Generator<VectorPointTuple> {
  const edge = Math.max(1, Math.trunc(p.vector_resolution ?? 1024));
  const path = p.scan_path ?? "vertical_raster";
  const x0 = Math.min(p.roi?.x_start ?? 0, p.roi?.x_end ?? ADC_MAX);
  const x1 = Math.max(p.roi?.x_start ?? 0, p.roi?.x_end ?? ADC_MAX);
  const y0 = Math.min(p.roi?.y_start ?? 0, p.roi?.y_end ?? ADC_MAX);
  const y1 = Math.max(p.roi?.y_start ?? 0, p.roi?.y_end ?? ADC_MAX);
  const xs = Array.from({ length: edge }, (_, index) =>
    Math.round(x0 + ((x1 - x0) * index) / Math.max(1, edge - 1)),
  );
  const ys = Array.from({ length: edge }, (_, index) =>
    Math.round(y0 + ((y1 - y0) * index) / Math.max(1, edge - 1)),
  );
  if (path === "horizontal_sawtooth" || path === "horizontal_triangle") {
    for (let row = 0; row < ys.length; row++) {
      const y = ys[row];
      const rowXs = path === "horizontal_triangle" && row % 2 ? [...xs].reverse() : xs;
      for (const x of rowXs) yield [x, y, p.dwell];
    }
    return;
  }

  for (let column = 0; column < xs.length; column++) {
    const x = xs[column];
    const columnYs = path === "vertical_serpentine" && column % 2 ? [...ys].reverse() : ys;
    for (const y of columnYs) yield [x, y, p.dwell];
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
      vacuum_enabled: false,
    };
  },
  defaults() {
    const streamDataConfig = loadStreamDataConfig();
    const action = actionDataFromConfig(streamDataConfig);
    const raster = action.rasterScan ?? {};
    const vector = action.vectorScan ?? {};
    const selectedBeam = action.enableEbeam ? "ebeam" : "ion";
    const ev = finiteNumber(action.ev, 1000.0);
    const voltage = finiteNumber(action.voltage, 2.5);
    return {
      is_production: false,
      takeover: {
        ext_switch_delay_ms: finiteNumber(
          (action.timings as Record<string, unknown> | undefined)?.ext_switch_delay_ms, 20),
      },
      adc_test: streamDataConfig.AdcTest !== false && action.AdcTest !== false,
      ev,
      voltage,
      simulation: action.simulation ?? {},
      raster: {
        ...raster,
        voltage,
        resolution: finiteNumber(raster.resolution, 512),
        dwell: finiteNumber(raster.dwell, 16),
        latency: finiteNumber(raster.latency, finiteNumber(raster.pixels, 8192) * 2),
        frameBlank: Boolean(raster.frameBlank ?? true),
      },
      vector: {
        ...vector,
        dwell: finiteNumber(vector.dwell, 7),
        vectorResolution: finiteNumber(vector.vectorResolution, 1024),
        voltage,
        latency: finiteNumber(vector.latency, 8196),
        outputMode: vector.outputMode ?? "EightBit",
      },
      raster_params: {
        resolution: finiteNumber(raster.resolution, 512),
        dwell: finiteNumber(raster.dwell, 16),
        latency_bytes: finiteNumber(raster.latency, finiteNumber(raster.pixels, 8192) * 2),
        frame_blank: Boolean(raster.frameBlank ?? true),
        cookie: finiteNumber(raster.cookie, 123),
        output_mode: raster.outputMode ?? "EightBit",
      },
      vector_params: {
        vector_resolution: finiteNumber(vector.vectorResolution, 1024),
        dwell: finiteNumber(vector.dwell, 7),
        latency_bytes: finiteNumber(vector.latency, 8196),
        cookie: finiteNumber(vector.cookie, 123),
        output_mode: vector.outputMode ?? "EightBit",
        pre_process: Boolean(vector.preProcess ?? false),
        do_validate: Boolean(vector.doValidate ?? true),
      },
      selected_beam: selectedBeam,
      version: typeof streamDataConfig.Version === "string" ? streamDataConfig.Version : "",
    };
  },
  runRaster(req: RasterParams & { do_validate?: boolean }) {
    const total = req.resolution * req.resolution * (req.parallel_rois?.length ?? 1);
    const pixelsPerChunk = Math.max(1, Math.floor(req.latency_bytes / Math.max(1, req.dwell)));
    const expected = Math.ceil(total / pixelsPerChunk);
    const ts = shortTimestampSuffix();
    const csvFilename = `raster_${req.resolution}x${req.resolution}_${ts}.csv`;
    const imageFilename = `raster_${req.resolution}x${req.resolution}_${ts}.png`;
    // Cache so /scan/last/* mock endpoints have something to return.
    mockLastScan = {
      kind: "raster",
      resolution: req.resolution,
      latency_bytes: req.latency_bytes,
      source: "validated",
      csv_filename: csvFilename,
      image_filename: imageFilename,
    };
    return {
      kind: "raster",
      chunks: expected,
      bytes: total * 2,
      csv_filename: csvFilename,
      image_filename: imageFilename,
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
      totalSamples = vectorScanPoints(req).length * (req.parallel_rois?.length ?? 1);
    }
    const valuesPerChunk = Math.max(64, Math.floor(req.latency_bytes / 2));
    const chunks = Math.max(1, Math.ceil(totalSamples / valuesPerChunk));
    const ts = shortTimestampSuffix();
    const csvFilename = `vector_latency_${req.latency_bytes}_${ts}.csv`;
    const imageFilename = `vector_latency_${req.latency_bytes}_${ts}.png`;
    mockLastScan = {
      kind: "vector",
      latency_bytes: req.latency_bytes,
      pattern: req.pattern,
      scan_path: req.scan_path ?? "vertical_raster",
      vector_resolution: req.vector_resolution,
      source: "validated",
      csv_filename: csvFilename,
      image_filename: imageFilename,
    };
    return {
      kind: "vector",
      chunks,
      bytes: chunks * req.latency_bytes,
      dwell: req.dwell,
      csv_filename: csvFilename,
      image_filename: imageFilename,
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
    const filename =
      mockLastScan.csv_filename ??
      (mockLastScan.kind === "raster"
        ? `raster_${mockLastScan.resolution}x${mockLastScan.resolution}_${shortTimestampSuffix()}.csv`
        : `vector_latency_${mockLastScan.latency_bytes}_${shortTimestampSuffix()}.csv`);
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
      scan_path?: VectorScanPath;
      vector_resolution?: number;
      source: "validated" | "stream";
      csv_filename?: string;
      image_filename?: string;
    }
  | null = null;
