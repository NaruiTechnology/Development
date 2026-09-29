import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeScanSamples,
  OBI_SCAN_FULL_SCALE,
  scaleScanSample,
} from "../.test-dist/lib/scanSamples.js";

test("SixteenBit scan samples remain exact native little-endian OBI values", () => {
  const bytes = Uint8Array.from([0x00, 0x00, 0x34, 0x12, 0xfc, 0xff]);
  assert.deepEqual(
    [...decodeScanSamples(bytes.buffer, "SixteenBit")],
    [0x0000, 0x1234, OBI_SCAN_FULL_SCALE],
  );
});

test("EightBit full scale expands to the same display full scale", () => {
  const bytes = Uint8Array.from([0x00, 0x80, 0xff]);
  const samples = decodeScanSamples(bytes.buffer, "EightBit");

  assert.equal(samples[0], 0);
  assert.equal(samples[2], OBI_SCAN_FULL_SCALE);
  assert.ok(samples[1] > 0x7f00 && samples[1] < 0x8100);
});

test("live display contrast expands a valid narrow ADC range", () => {
  assert.equal(scaleScanSample(0x7ee4, 0x7ee4, 0x9fac), 0);
  assert.equal(scaleScanSample(0x9fac, 0x7ee4, 0x9fac), 255);
  const middle = scaleScanSample(0x8f48, 0x7ee4, 0x9fac);
  assert.ok(middle >= 126 && middle <= 129);
});

test("absolute gray-selection scale and constant frames remain stable", () => {
  assert.equal(scaleScanSample(0), 0);
  assert.equal(scaleScanSample(OBI_SCAN_FULL_SCALE), 255);
  assert.equal(scaleScanSample(0), 0, 0);
});

test("native decoding returns a view without copying and rejects partial words", () => {
  const buffer = new Uint16Array([4, 65532]).buffer;
  assert.equal(decodeScanSamples(buffer).buffer, buffer);
  assert.throws(() => decodeScanSamples(new ArrayBuffer(1)), /Truncated/);
});
