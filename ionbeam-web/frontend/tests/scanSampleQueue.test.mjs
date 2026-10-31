import test from "node:test";
import assert from "node:assert/strict";
import { createPendingSamples, queuePendingSamples, flushPendingSamples, discardPendingSamples,
  MAX_PENDING_SAMPLE_BYTES } from "../.test-dist/lib/scanSampleQueue.js";

test("paused animation frames cannot accumulate an unbounded scan backlog", () => {
  const previous = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  const frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = (fn) => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = (key) => frames.delete(key);
  const pending = createPendingSamples();
  let received = 0;
  let chunks = 0;
  const flush = () => flushPendingSamples(pending, (samples) => {
    for (const value of samples) assert.equal(value, 17);
    received += samples.length;
  }, (counts) => { chunks += counts.chunks; });
  try {
    const chunk = new Uint16Array(65536).fill(17);
    for (let i = 0; i < 40; i++) {
      queuePendingSamples(pending, chunk, chunk.byteLength, flush);
      assert.ok(pending.sampleBytes < MAX_PENDING_SAMPLE_BYTES);
    }
    flush();
    assert.equal(received, chunk.length * 40);
    assert.equal(chunks, 40);
    assert.equal(frames.size, 0);
    assert.equal(pending.timer, null);
  } finally {
    discardPendingSamples(pending);
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previous;
  }
});

test("timer fallback flushes ordered samples without an animation frame", async () => {
  const previous = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const pending = createPendingSamples();
  let values = [];
  try {
    await new Promise((resolve) => {
      const flush = () => flushPendingSamples(pending, (samples) => { values = [...samples]; }, resolve);
      queuePendingSamples(pending, Uint16Array.of(1, 2), 4, flush);
      queuePendingSamples(pending, Uint16Array.of(3), 2, flush);
    });
    assert.deepEqual(values, [1, 2, 3]);
    assert.equal(pending.chunks.length, 0);
    assert.equal(pending.timer, null);
  } finally {
    discardPendingSamples(pending);
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previous;
  }
});

test("discard cancels scheduled work and releases every pending buffer", () => {
  const previous = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  let cancelled = null;
  globalThis.requestAnimationFrame = () => 7;
  globalThis.cancelAnimationFrame = (id) => { cancelled = id; };
  const pending = createPendingSamples();
  try {
    queuePendingSamples(pending, Uint16Array.of(1), 2, () => assert.fail("discarded work ran"));
    discardPendingSamples(pending);
    assert.equal(cancelled, 7);
    assert.equal(pending.sampleBytes, 0);
    assert.equal(pending.chunks.length, 0);
    assert.equal(pending.timer, null);
  } finally {
    discardPendingSamples(pending);
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = previous;
  }
});
