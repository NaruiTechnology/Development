import { apiUrl } from "./backendUrl.js";
import type { ScanResult } from "../types/api";

async function capture(path: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(apiUrl(path), { signal, cache: "no-store" });
    if (!response.ok) return null;
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(parts.join(""))}`;
  } catch {
    // A missing render must never fall back to a different workspace's latest run.
    return null;
  }
}

export async function captureScanResultArtifacts(
  result: ScanResult, render: "native" | "decimated", signal: AbortSignal,
): Promise<ScanResult> {
  const [csvDataUrl, figureDataUrl] = await Promise.all([
    capture("/api/scan/last/csv", signal),
    capture(`/api/scan/last/figure?render=${render}&view=texture`, signal),
  ]);
  return { ...result, artifacts: { csvDataUrl, figureDataUrl } };
}
