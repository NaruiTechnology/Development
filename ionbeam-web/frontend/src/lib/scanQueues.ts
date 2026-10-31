import type { RasterRequest, ROIRequest, VectorRequest } from "../types/api";
import { apiUrl } from "./backendUrl.js";
import { scanAuthHeaders } from "./authIdentity.js";
import { prepareScanAssets } from "./scanAssets.js";
import type { ScanType } from "../types/scanType";

export type StoredScanEntry =
  | {
      kind: "raster";
      req: RasterRequest;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
    }
  | {
      kind: "vector";
      req: VectorRequest;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      scanType: ScanType;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
    };

export type ScanQueueSummary = {
  id: string;
  status: "queued" | "running" | "interrupted" | "completed";
  next_index: number;
  total: number;
};

async function queueJson(path: string, init?: RequestInit) {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...scanAuthHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(String(result.detail ?? `queue request failed: HTTP ${response.status}`));
  return result;
}

/** Prepare once per sequence so repeating ROI passes reuse uploaded asset IDs. */
export async function prepareScanSequence(entries: StoredScanEntry[]): Promise<StoredScanEntry[]> {
  const prepared: StoredScanEntry[] = [];
  for (const entry of entries) {
    const bitmap = entry.req.simulation_bitmap;
    const parallelBitmaps = entry.req.parallel_simulation_bitmaps;
    prepared.push({
      ...entry,
      simulationBitmapInfo: entry.simulationBitmapInfo ?? (bitmap
        ? { width: bitmap.width, height: bitmap.height }
        : null),
      hasSimulationBitmap: entry.hasSimulationBitmap ?? Boolean(
        bitmap || entry.req.simulation_bitmap_id || parallelBitmaps?.length ||
        entry.req.parallel_simulation_bitmap_ids?.length,
      ),
      req: await prepareScanAssets(entry.req),
    } as StoredScanEntry);
  }
  return prepared;
}

export async function createScanQueue(entries: StoredScanEntry[]): Promise<{ summary: ScanQueueSummary; entries: StoredScanEntry[] }> {
  const prepared = await prepareScanSequence(entries);
  const summary = await queueJson("/api/scan/queues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: prepared }),
  }) as ScanQueueSummary;
  return {
    summary,
    entries: prepared.map((entry, index) => ({
      ...entry,
      req: { ...entry.req, queue_id: summary.id, queue_index: index },
    })) as StoredScanEntry[],
  };
}

export async function latestScanQueue(): Promise<ScanQueueSummary | null> {
  return queueJson("/api/scan/queues/latest") as Promise<ScanQueueSummary | null>;
}

export async function loadScanQueue(summary: ScanQueueSummary): Promise<StoredScanEntry[]> {
  const entries: StoredScanEntry[] = [];
  for (let page = 0; page * 100 < summary.total; page += 1) {
    const result = await queueJson(`/api/scan/queues/${summary.id}?page=${page}&page_size=100`) as {
      entries: StoredScanEntry[];
    };
    entries.push(...result.entries);
  }
  return entries.map((entry, index) => ({
    ...entry,
    req: { ...entry.req, queue_id: summary.id, queue_index: index },
  })) as StoredScanEntry[];
}
