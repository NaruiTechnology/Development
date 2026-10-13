import test from "node:test";
import assert from "node:assert/strict";

import {
  BeamHoldRecorder,
  analyzeBeamHold,
} from "../.test-dist/lib/beamHoldAnalysis.js";

// 1 us samples, like dwell 7 at 8 MHz.
const PERIOD_US = 1;

function record(seconds, { level = 9000, noise = 60, dip = null, seed = 7 } = {}) {
  const rec = new BeamHoldRecorder(PERIOD_US);
  let state = seed;
  const total = Math.round((seconds * 1e6) / PERIOD_US);
  const chunk = new Float64Array(20000);
  for (let base = 0; base < total; base += chunk.length) {
    const n = Math.min(chunk.length, total - base);
    for (let k = 0; k < n; k++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const tMs = ((base + k) * PERIOD_US) / 1000;
      const inDip = dip && tMs % dip.everyMs >= dip.offsetMs && tMs % dip.everyMs < dip.offsetMs + dip.lengthMs;
      chunk[k] = (inDip ? dip.level : level) + ((state >> 16) % (2 * noise)) - noise;
    }
    rec.push(chunk.subarray(0, n));
  }
  return rec;
}

const analyse = (rec) => analyzeBeamHold(rec.means, rec.length, rec.bucketMs);

test("buckets are 0.25 ms and keep every sample", () => {
  const rec = record(1);
  assert.equal(rec.samplesPerBucket, 250);
  assert.equal(rec.sampleCount, 1_000_000);
  assert.equal(rec.length, 4000);
  assert.ok(Math.abs(rec.elapsedMs - 1000) < 1e-6);
});

test("a steady parked beam is clean", () => {
  const a = analyse(record(3));
  assert.equal(a.verdict, "clean");
  assert.equal(a.dips.length, 0);
});

test("the black-line signature is found: 1.5 ms dips every 195 ms", () => {
  const a = analyse(record(3, { dip: { everyMs: 195, offsetMs: 50, lengthMs: 1.5, level: 300 } }));
  assert.equal(a.verdict, "periodic");
  assert.equal(a.dips.length, 16);
  assert.ok(Math.abs(a.medianSpacingMs - 195) < 0.5, `spacing ${a.medianSpacingMs}`);
  assert.ok(Math.abs(a.medianLengthMs - 1.5) <= 0.25, `length ${a.medianLengthMs}`);
  assert.ok(a.dips[0].depth > 8000);
});

test("shallow dips well above the noise are still found", () => {
  const a = analyse(record(3, { dip: { everyMs: 195, offsetMs: 50, lengthMs: 1.5, level: 7800 } }));
  assert.equal(a.verdict, "periodic");
  assert.equal(a.dips.length, 16);
});

test("slow drift is not a dip", () => {
  const rec = new BeamHoldRecorder(PERIOD_US);
  const n = 2_000_000;
  const chunk = new Float64Array(n);
  for (let i = 0; i < n; i++) chunk[i] = 9000 - (i / n) * 1500; // 1500 codes over 2 s
  rec.push(chunk);
  assert.equal(analyse(rec).dips.length, 0);
});

test("irregular dips are reported as irregular", () => {
  const rec = record(3);
  for (const ms of [120, 400, 1300, 1450, 2600]) {
    const b = Math.round(ms / rec.bucketMs);
    for (let i = b; i < b + 6; i++) rec.means[i] = 300;
  }
  const a = analyse(rec);
  assert.equal(a.dips.length, 5);
  assert.equal(a.verdict, "irregular");
});

test("too little data waits instead of guessing", () => {
  assert.equal(analyse(record(0.2)).verdict, "tooShort");
});
