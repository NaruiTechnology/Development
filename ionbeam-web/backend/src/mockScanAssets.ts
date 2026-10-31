/** Disk-backed assets with a bounded memory cache for MOCK=1. */
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_CACHED_ASSETS = 4;
const uploads = new Map<string, { total: number; chunks: Buffer[]; offset: number; touched: number }>();
const assets = new Map<string, { bitmap: unknown; bytes: number }>();

function validId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}

function assetPath(id: string): string {
  if (!validId(id)) throw new Error("invalid scan asset ID");
  const cacheRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local")
    : path.join(homedir(), ".cache");
  const directory = process.env.IONBEAM_MOCK_SCAN_ASSET_DIR ??
    path.join(cacheRoot, "ionbeam-web", "mock-scan-assets");
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${id}.json`);
}

function cacheAsset(id: string, bitmap: unknown, bytes: number) {
  let cachedBytes = [...assets.values()].reduce((sum, asset) => sum + asset.bytes, 0);
  while (assets.size && (assets.size >= MAX_CACHED_ASSETS || cachedBytes + bytes > MAX_ASSET_BYTES)) {
    const oldest = assets.keys().next().value!;
    cachedBytes -= assets.get(oldest)!.bytes;
    assets.delete(oldest);
  }
  assets.set(id, { bitmap, bytes });
}

export function prepareMockScanAsset(id: string, total: number) {
  if (!validId(id) || !Number.isInteger(total) || total < 1 || total > MAX_ASSET_BYTES) {
    throw new Error("invalid scan asset ID or size");
  }
  if (assets.has(id)) {
    getMockScanAsset(id);
    return { asset_id: id, cached: true, offset: total };
  }
  if (existsSync(assetPath(id))) return { asset_id: id, cached: true, offset: total };
  for (const [key, upload] of uploads) {
    if (Date.now() - upload.touched > 5 * 60_000) uploads.delete(key);
  }
  const existing = uploads.get(id);
  if (existing && existing.total !== total) throw new Error("asset upload size changed");
  if (!existing) {
    const reserved = [...uploads.values()].reduce((sum, upload) => sum + upload.total, 0);
    if (uploads.size >= MAX_CACHED_ASSETS || reserved + total > MAX_ASSET_BYTES) {
      throw new Error("scan asset upload capacity reached; finish existing uploads first");
    }
    uploads.set(id, { total, chunks: [], offset: 0, touched: Date.now() });
  } else existing.touched = Date.now();
  return { asset_id: id, cached: false, offset: uploads.get(id)!.offset };
}

export function appendMockScanAsset(id: string, offset: number, chunk: Buffer) {
  if (!chunk.length || chunk.length > MAX_CHUNK_BYTES) throw new Error("invalid scan asset chunk size");
  const upload = uploads.get(id);
  if (!upload) throw new Error("prepare scan asset before sending chunks");
  if (offset !== upload.offset || offset + chunk.length > upload.total) {
    throw new Error(`expected chunk offset ${upload.offset}`);
  }
  upload.chunks.push(chunk);
  upload.offset += chunk.length;
  upload.touched = Date.now();
  return { asset_id: id, offset: upload.offset };
}

export function completeMockScanAsset(id: string) {
  if (assets.has(id) || existsSync(assetPath(id))) return { asset_id: id, cached: true };
  const upload = uploads.get(id);
  if (!upload || upload.offset !== upload.total) throw new Error("scan asset upload is incomplete");
  // A completed or invalid upload must not leave its raw chunks retained.
  uploads.delete(id);
  const bytes = Buffer.concat(upload.chunks);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("scan asset checksum mismatch");
  const bitmap = JSON.parse(bytes.toString("utf8"));
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) ||
      !Array.isArray(bitmap.pixels) || bitmap.pixels.length !== bitmap.width * bitmap.height) {
    throw new Error("invalid scan bitmap");
  }
  const file = assetPath(id);
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  cacheAsset(id, bitmap, bytes.length);
  return { asset_id: id, cached: false };
}

export function getMockScanAsset(id: string): unknown {
  let asset = assets.get(id);
  if (!asset) {
    const file = assetPath(id);
    if (!existsSync(file)) throw new Error(`scan asset ${id} is missing; upload it again`);
    const bytes = readFileSync(file);
    cacheAsset(id, JSON.parse(bytes.toString("utf8")), bytes.length);
    asset = assets.get(id)!;
  }
  assets.delete(id);
  assets.set(id, asset);
  return asset.bitmap;
}
