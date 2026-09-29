type ScanPerformance = {
  id: string;
  kind: string;
  transport: "websocket" | "desktop_native";
  startedAt: number;
  startedIso: string;
  firstSampleAt: number | null;
  chunks: number;
  bytes: number;
  streamComplete: boolean;
};

let activeScan: ScanPerformance | null = null;

export function beginScanPerformance(
  kind: string,
  request: Record<string, unknown>,
  transport: ScanPerformance["transport"],
): void {
  if (activeScan && !activeScan.streamComplete) {
    emit("superseded", activeScan);
  }
  const startedAt = performance.now();
  activeScan = {
    id: crypto.randomUUID(),
    kind,
    transport,
    startedAt,
    startedIso: new Date().toISOString(),
    firstSampleAt: null,
    chunks: 0,
    bytes: 0,
    streamComplete: false,
  };
  const params = Object.fromEntries(
    ["resolution", "vector_resolution", "dwell", "latency_bytes", "pattern", "scan_path", "preview"]
      .filter((key) => request[key] !== undefined)
      .map((key) => [key, request[key]]),
  );
  emit("start", activeScan, { params });
}

export function markScanPerformanceConnected(): void {
  if (activeScan) emit("connected", activeScan);
}

export function markScanPerformanceChunk(bytes: number): void {
  if (!activeScan) return;
  activeScan.chunks += 1;
  activeScan.bytes += bytes;
  if (activeScan.firstSampleAt === null) {
    activeScan.firstSampleAt = performance.now();
    emit("first_sample", activeScan, {
      first_sample_ms: elapsed(activeScan, activeScan.firstSampleAt),
      chunk_bytes: bytes,
    });
  }
}

export function markScanPerformanceControl(data: string): void {
  let event: unknown;
  try {
    event = (JSON.parse(data) as { event?: unknown }).event;
  } catch {
    return;
  }
  if (!activeScan) return;
  if (event === "done") {
    activeScan.streamComplete = true;
    emit("stream_complete", activeScan, {
      first_sample_ms: activeScan.firstSampleAt === null
        ? null
        : elapsed(activeScan, activeScan.firstSampleAt),
      chunks: activeScan.chunks,
      bytes: activeScan.bytes,
    });
  } else if (event === "error") {
    emit("stream_error", activeScan);
    activeScan = null;
  }
}

export function markScanPerformanceClosed(code: number): void {
  if (!activeScan || activeScan.streamComplete) return;
  emit("stream_closed", activeScan, { close_code: code });
  activeScan = null;
}

export function markScanPerformanceCanvasReady(kind: string): void {
  if (!activeScan || !activeScan.streamComplete || activeScan.kind !== kind) return;
  emit("canvas_ready", activeScan);
  activeScan = null;
}

function emit(event: string, scan: ScanPerformance, extra: Record<string, unknown> = {}): void {
  console.info("[scan-perf]", JSON.stringify({
    event,
    scan_id: scan.id,
    kind: scan.kind,
    transport: scan.transport,
    started_at: scan.startedIso,
    elapsed_ms: elapsed(scan),
    ...extra,
  }));
}

function elapsed(scan: ScanPerformance, at = performance.now()): number {
  return Number((at - scan.startedAt).toFixed(2));
}
