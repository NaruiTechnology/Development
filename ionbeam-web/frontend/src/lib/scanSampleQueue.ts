/** Bound queued samples even when animation frames pause in a hidden tab. */
export const MAX_PENDING_SAMPLE_BYTES = 1024 * 1024;
export type PendingSamples = {
  chunks: Uint16Array[];
  bytes: number;
  chunkCount: number;
  sampleBytes: number;
  animationFrame: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createPendingSamples(): PendingSamples {
  return { chunks: [], bytes: 0, chunkCount: 0, sampleBytes: 0, animationFrame: null, timer: null };
}

function cancelPending(pending: PendingSamples): void {
  if (pending.animationFrame !== null) cancelAnimationFrame(pending.animationFrame);
  if (pending.timer !== null) clearTimeout(pending.timer);
  pending.animationFrame = null;
  pending.timer = null;
}

export function queuePendingSamples(pending: PendingSamples, samples: Uint16Array, bytes: number, flush: () => void): void {
  // Drain the previous batch first, so concatenation never builds a huge copy.
  if (pending.sampleBytes + samples.byteLength > MAX_PENDING_SAMPLE_BYTES) flush();
  pending.chunks.push(samples);
  pending.bytes += bytes;
  pending.sampleBytes += samples.byteLength;
  pending.chunkCount += 1;
  if (pending.sampleBytes >= MAX_PENDING_SAMPLE_BYTES) {
    flush();
    return;
  }
  if (pending.animationFrame === null) {
    pending.animationFrame = requestAnimationFrame(flush);
    pending.timer = setTimeout(flush, 50);
  }
}

export function flushPendingSamples(pending: PendingSamples, append: (samples: Uint16Array) => void,
  progress: (counts: { bytes: number; chunks: number }) => void): void {
  cancelPending(pending);
  if (!pending.chunkCount) return;
  const samples = pending.chunks.length === 1 ? pending.chunks[0] : new Uint16Array(pending.sampleBytes / 2);
  if (pending.chunks.length > 1) {
    let offset = 0;
    for (const chunk of pending.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
  }
  const counts = { bytes: pending.bytes, chunks: pending.chunkCount };
  discardPendingSamples(pending);
  append(samples);
  progress(counts);
}

export function discardPendingSamples(pending: PendingSamples): void {
  cancelPending(pending);
  pending.chunks = [];
  pending.bytes = 0;
  pending.sampleBytes = 0;
  pending.chunkCount = 0;
}
