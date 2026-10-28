/** In-memory counterpart of the Glasgow scan-asset protocol for MOCK=1. */
import crypto from "node:crypto";

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;
const uploads = new Map<string, { total: number; chunks: Buffer[]; offset: number }>();
const assets = new Map<string, unknown>();

function validId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id);
}

export function prepareMockScanAsset(id: string, total: number) {
  if (!validId(id) || !Number.isInteger(total) || total < 1 || total > MAX_ASSET_BYTES) {
    throw new Error("invalid scan asset ID or size");
  }
  if (assets.has(id)) return { asset_id: id, cached: true, offset: total };
  const existing = uploads.get(id);
  if (existing && existing.total !== total) throw new Error("asset upload size changed");
  if (!existing) uploads.set(id, { total, chunks: [], offset: 0 });
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
  return { asset_id: id, offset: upload.offset };
}

export function completeMockScanAsset(id: string) {
  if (assets.has(id)) return { asset_id: id, cached: true };
  const upload = uploads.get(id);
  if (!upload || upload.offset !== upload.total) throw new Error("scan asset upload is incomplete");
  const bytes = Buffer.concat(upload.chunks);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("scan asset checksum mismatch");
  const bitmap = JSON.parse(bytes.toString("utf8"));
  if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) ||
      !Array.isArray(bitmap.pixels) || bitmap.pixels.length !== bitmap.width * bitmap.height) {
    throw new Error("invalid scan bitmap");
  }
  assets.set(id, bitmap);
  uploads.delete(id);
  return { asset_id: id, cached: false };
}

export function getMockScanAsset(id: string): unknown {
  const asset = assets.get(id);
  if (!asset) throw new Error(`scan asset ${id} is missing; upload it again`);
  return asset;
}
