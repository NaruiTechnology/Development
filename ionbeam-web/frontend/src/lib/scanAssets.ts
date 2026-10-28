import type { RasterRequest, SimulationBitmap, VectorRequest } from "../types/api";
import { apiUrl } from "./backendUrl.js";
import { scanAuthHeaders } from "./authIdentity.js";

const CHUNK_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_WS_REQUEST_BYTES = 16 * 1024 * 1024;

async function requestJson(path: string, method: "POST" | "PUT", body?: BodyInit, contentType?: string) {
  const response = await fetch(apiUrl(path), {
    method,
    headers: { ...scanAuthHeaders(), ...(contentType ? { "Content-Type": contentType } : {}) },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.detail ?? result.error ?? `asset upload failed: HTTP ${response.status}`));
  return result as { asset_id: string; cached?: boolean; offset?: number };
}

async function uploadBitmap(bitmap: SimulationBitmap): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(bitmap));
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("simulation bitmap exceeds the 64 MiB asset limit");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const assetId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const prepared = await requestJson(
    "/api/scan/assets/prepare", "POST",
    JSON.stringify({ asset_id: assetId, total_bytes: bytes.byteLength }), "application/json",
  );
  if (!prepared.cached) {
    let offset = prepared.offset ?? 0;
    while (offset < bytes.byteLength) {
      const chunk = bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
      const result = await requestJson(
        `/api/scan/assets/${assetId}/chunk?offset=${offset}`, "PUT", chunk,
        "application/octet-stream",
      );
      if (!Number.isInteger(result.offset) || result.offset! <= offset) {
        throw new Error("asset upload made no progress");
      }
      offset = result.offset!;
    }
    await requestJson(`/api/scan/assets/${assetId}/complete`, "POST");
  }
  return assetId;
}

/** Upload each unique bitmap once, then keep the WebSocket control message small. */
export async function prepareScanAssets<T extends RasterRequest | VectorRequest>(request: T): Promise<T> {
  const pending = new Map<string, Promise<string>>();
  const upload = (bitmap: SimulationBitmap) => {
    const key = JSON.stringify(bitmap);
    let promise = pending.get(key);
    if (!promise) {
      promise = uploadBitmap(bitmap);
      pending.set(key, promise);
    }
    return promise;
  };
  const [singleId, parallelIds] = await Promise.all([
    request.simulation_bitmap
      ? upload(request.simulation_bitmap)
      : Promise.resolve(request.simulation_bitmap_id ?? null),
    request.parallel_simulation_bitmaps?.length
      ? Promise.all(request.parallel_simulation_bitmaps.map(upload))
      : Promise.resolve(request.parallel_simulation_bitmap_ids ?? null),
  ]);
  const prepared = {
    ...request,
    simulation_bitmap: null,
    parallel_simulation_bitmaps: null,
    simulation_bitmap_id: singleId,
    parallel_simulation_bitmap_ids: parallelIds,
  } as T;
  if (new TextEncoder().encode(JSON.stringify(prepared)).byteLength > MAX_WS_REQUEST_BYTES) {
    throw new Error("scan control request exceeds the 16 MiB WebSocket limit; split the ROI queue into smaller batches");
  }
  return prepared;
}
