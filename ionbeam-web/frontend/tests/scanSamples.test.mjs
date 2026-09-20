import test from "node:test";
import assert from "node:assert/strict";

import { decodeScanSamples, OBI_SCAN_FULL_SCALE } from "../.test-dist/lib/scanSamples.js";

test("SixteenBit scan samples remain exact big-endian OBI values", () => {
  const bytes = Uint8Array.from([0x00, 0x00, 0x12, 0x34, 0xff, 0xfc]);
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
