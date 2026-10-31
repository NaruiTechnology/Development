import type { RasterRequest, SimulationBitmap, VectorRequest } from "../types/api";
import { apiUrl } from "./backendUrl.js";
import { scanAuthHeaders } from "./authIdentity.js";

const CHUNK_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_WS_REQUEST_BYTES = 16 * 1024 * 1024;

/** Bound each JSON conversion so Firefox can paint and handle Stop while
 * preparing gray-filtered images. Never build one multi-megabyte JSON string. */
export async function encodeSimulationBitmap(bitmap: SimulationBitmap): Promise<Uint8Array<ArrayBuffer>> {
  const { pixels, ...metadata } = bitmap;
  const encoder = new TextEncoder();
  const header = JSON.stringify(metadata);
  const parts = [encoder.encode(`${header.slice(0, -1)},"pixels":[`)];
  let total = parts[0].byteLength;
  let deadline = performance.now() + 8;
  for (let offset = 0; offset < pixels.length; offset += 2048) {
    const json = JSON.stringify(pixels.slice(offset, offset + 2048));
    const part = encoder.encode(`${offset ? "," : ""}${json.slice(1, -1)}`);
    total += part.byteLength;
    if (total + 2 > MAX_ASSET_BYTES) throw new Error("simulation bitmap exceeds the 64 MiB asset limit");
    parts.push(part);
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
    }
  }
  // Blob concatenation avoids a second full-sized intermediate JSON string.
  return new Uint8Array(await new Blob([...parts, encoder.encode("]}")]).arrayBuffer());
}

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

async function uploadBitmap(bytes: Uint8Array, assetId: string): Promise<string> {
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
  const identities = new WeakMap<SimulationBitmap, string>();
  const upload = async (bitmap: SimulationBitmap) => {
    const existing = identities.get(bitmap);
    if (existing) return existing;
    const bytes = await encodeSimulationBitmap(bitmap);
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("simulation bitmap exceeds the 64 MiB asset limit");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    let promise = pending.get(key);
    if (!promise) {
      promise = uploadBitmap(bytes, key);
      pending.set(key, promise);
    }
    const id = await promise;
    identities.set(bitmap, id);
    return id;
  };
  // Process one bitmap at a time instead of holding multiple JSON strings,
  // encoded copies, and upload bodies concurrently for parallel ROIs.
  const singleId = request.simulation_bitmap
    ? await upload(request.simulation_bitmap) : request.simulation_bitmap_id ?? null;
  let parallelIds = request.parallel_simulation_bitmap_ids ?? null;
  if (request.parallel_simulation_bitmaps?.length) {
    parallelIds = [];
    for (const bitmap of request.parallel_simulation_bitmaps) parallelIds.push(await upload(bitmap));
  }
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
